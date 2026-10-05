#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
============================================================================
AirGuard D3 —— 【干预—验证—恢复】事件状态机（报告端实现）
============================================================================

报告端要能把整条事件链画出来：

    ① 收到异常 MQTT 数据 → 该区域标为「优先关注」，事件建立（OPEN 待处理）
    ② 用户在 Web / 移动端 / 3D 里选择干预动作 → 广播 Airguard-x9k2m/intervention/<区域>
    ③ 各端（含本报告）收到广播 → 事件转 HANDLING 处理中
    ④ 继续收后续 MQTT 数据 → 实时重新分析
    ⑤ 按新数据自动判定 → 仍需关注 / 已恢复（干预后连续恶化还会回退 OPEN）

**状态机规则与 web / 移动端 / 小程序 / 3D 四端逐字同款**，不另立一套：
只有「无事件 + 监测到异常」才建事件；只有「管理员提交干预」才 OPEN → HANDLING；
只有「干预后收到一条达标的新监测数据」才 HANDLING → RECOVERED ——
点按钮永远不可能直接置为已恢复，OPEN → RECOVERED 这条跳转在代码里根本不存在。

本模块只读：不写 data/ 下任何文件，状态在内存里。
============================================================================
"""

from __future__ import annotations

import html
from datetime import datetime

from d5 import esc, parse_time, _to_num          # 复用 D5 的时间解析与转义

# ---------------------------------------------------------------------------
# 0. 常量：与四端逐字一致（改这里就等于改四端的规则，务必同步）
# ---------------------------------------------------------------------------

EV_OPEN = "OPEN"
EV_HANDLING = "HANDLING"
EV_RECOVERED = "RECOVERED"

EV_RELAPSE_SAMPLES = 2        # 干预后连续这么多组数据严重度高于干预时 → 回退 OPEN
                              # （恢复不设门槛：干预后第一条达标数据即判定恢复）
EV_CONFIDENCE_FLOOR = 0.6     # 低于此值视为低可信度感知数据
EV_DEDUPE_MAX = 500           # 去重键保留上限
EV_LOG_MAX = 40               # 单个事件最多留存的原始消息条数
MAX_EVENTS = 50               # 报告里最多保留的事件条数

LEVELS = {
    "good":     {"label": "正常",         "rank": 0, "hex": "#0ca30c"},
    "warning":  {"label": "轻度污染",     "rank": 1, "hex": "#fab219"},
    "serious":  {"label": "通风不足风险", "rank": 2, "hex": "#ec835a"},
    "critical": {"label": "重度污染",     "rank": 3, "hex": "#d03b3b"},
}

CROWD_LEVELS = {
    0: {"label": "稀疏",     "hex": "#898781"},
    1: {"label": "正常",     "hex": "#0ca30c"},
    2: {"label": "拥挤",     "hex": "#fab219"},
    3: {"label": "严重拥挤", "hex": "#d03b3b"},
}

EV_ACTIONS = {
    "warning":  ["开启低档位新风", "广播提醒开窗通风", "安排教室巡检"],
    "critical": ["全开新风+喷雾降尘", "关闭外窗", "暂停大型聚集活动"],
    "serious":  ["开启教室新风换气机组", "课间开窗提醒", "延长排风扇工作时间"],
    "crowd2":   ["安排人员走廊分流", "大屏错峰下课提示", "开放备用通道"],
    "crowd3":   ["区域入口限流", "广播引导疏散", "上报值班老师"],
}

EV_LABEL = {
    EV_OPEN: "OPEN 待处理",
    EV_HANDLING: "HANDLING 处理中",
    EV_RECOVERED: "RECOVERED 已恢复",
}

ZONE_NAME = {"zone-n": "宿舍区", "zone-s": "教学区", "zone-w": "食堂区"}
CSV_NOTE = "CSV 历史行"

INTERVENTION_TOPIC = "Airguard-x9k2m/intervention/{zone}"


# ---------------------------------------------------------------------------
# 1. 判据（与四端同款）
# ---------------------------------------------------------------------------

def evaluate_level(pm25, co2) -> str:
    """预警判断：不信报文里的 status，一律按阈值本地重算。PM2.5 优先于 CO₂"""
    if pm25 > 150:
        return "critical"
    if pm25 > 75:
        return "warning"
    if co2 >= 1500:
        return "serious"
    return "good"


def severity_of(level_rank: int, crowd: int) -> int:
    """严重度：环境等级优先、人流次之。干预后拿它跟干预那一刻比，判断是恶化还是没达标"""
    return level_rank * 4 + crowd


def is_abnormal(level: str, crowd: int) -> bool:
    return level != "good" or crowd >= 2


def is_recovered_env(level: str, crowd: int) -> bool:
    return level == "good" and crowd <= 1


def event_type_of(level_rank: int, crowd: int) -> str:
    return "环境异常" if level_rank >= crowd else "人流拥挤"


def action_key_of(level: str, crowd: int) -> str:
    if event_type_of(LEVELS[level]["rank"], crowd) == "人流拥挤":
        return "crowd%d" % max(2, min(3, crowd))
    return level


def build_reason(reading: dict) -> str:
    """优先关注理由：把「为什么是它」写成人话存进事件字段"""
    lv = LEVELS[reading["level"]]
    ci = CROWD_LEVELS[reading["crowdLevel"]]
    return (f"PM2.5 {reading['pm25']} μg/m³ / CO₂ {reading['co2']} ppm（{lv['label']}）"
            f"+ 人流{ci['label']} {reading['crowdLevel']} 级 → 严重度 "
            f"{severity_of(lv['rank'], reading['crowdLevel'])}")


def fnv1a(text: str) -> str:
    """与四端同款的载荷指纹（FNV-1a 32 位，十六进制）"""
    h = 0x811C9DC5
    for ch in text:
        h ^= ord(ch)
        h = (h * 0x01000193) & 0xFFFFFFFF
    return format(h, "08x")


def dedupe_key(payload: dict, zone_id: str, reading: dict) -> str:
    """去重键：优先 message_id；没有才用 zoneId + 时间 + 载荷指纹。
    event_id 绝不参与去重 —— 它标记同一个持续事件，跨多条消息保持不变。"""
    mid = payload.get("message_id", payload.get("messageid", payload.get("msgid")))
    if mid is not None and str(mid).strip():
        return f"{zone_id}|mid|{str(mid).strip()}"
    return (f"{zone_id}|sum|" + fnv1a("|".join(str(x) for x in [
        zone_id, reading["timeFull"], reading["pm25"], reading["co2"],
        reading["crowdLevel"], reading["level"],
    ])))


# ---------------------------------------------------------------------------
# 2. 事件状态机
# ---------------------------------------------------------------------------

class D3Engine:
    """收 MQTT 数据 / 干预广播 → 跑状态机 → 报告里画整条事件流程。

    feed() 对应四端的 ingest + applyEvent，receive_intervention() 对应
    各端的 receiveIntervention：只有 event_id 与本端该区活动事件相同、
    且状态仍是 OPEN 才应用，所以同一条干预重复到达天然幂等。
    """

    def __init__(self):
        self.events: list = []        # 全部事件，新的在前
        self.active: dict = {}        # zoneId -> 该区域当前（或最近一个）事件
        self.messages = 0             # 通过校验的数据报文
        self.duplicates = 0           # 重复到达、只算一次
        self.rejected = 0             # 缺字段 / 认不出区域，直接丢
        self.interventions = 0        # 收到的干预广播条数
        self.history_rows = 0         # 其中来自 CSV 历史行
        self.live_rows = 0            # 其中来自实时 MQTT
        self.skipped = 0             # 脏行/脏报文，解析失败被跳过
        self._seen: list = []
        self._seen_set: set = set()
        self._seq = 0
        self.last_at = None
        self.note = ""

    # -- 去重 ---------------------------------------------------------------
    def _is_duplicate(self, key: str) -> bool:
        if key in self._seen_set:
            return True
        self._seen_set.add(key)
        self._seen.append(key)
        if len(self._seen) > EV_DEDUPE_MAX:
            self._seen_set.discard(self._seen.pop(0))
        return False

    # -- 读数入库（含校验） --------------------------------------------------
    def _reading(self, payload: dict, zone_id: str, recv_at: datetime, source: str):
        pm25 = _to_num(payload.get("pm25", payload.get("pm2_5")))
        co2 = _to_num(payload.get("co2", payload.get("co2_ppm")))
        crowd = _to_num(payload.get("crowdLevel", payload.get("crowdlevel")))
        if pm25 is None or co2 is None or crowd is None:
            self.rejected += 1
            return None                      # 三项指标缺任意一项都视为无效报文

        raw_time = payload.get("time", payload.get("ts", payload.get("timestamp")))
        dt = parse_time(raw_time)
        if not isinstance(recv_at, datetime):      # CSV 里的 NaT 也会走到这儿
            recv_at = datetime.now()
        ts = dt.timestamp() * 1000.0 if dt is not None else recv_at.timestamp() * 1000.0
        crowd = int(max(0, min(3, round(crowd))))

        conf = _to_num(payload.get("confidence", payload.get("conf")))
        return {
            "zoneId": zone_id,
            "pm25": int(round(pm25)),
            "co2": int(round(co2)),
            "crowdLevel": crowd,
            "level": evaluate_level(pm25, co2),
            "ts": ts,
            "dt": dt,
            "timeFull": (dt if dt is not None else recv_at).strftime("%Y-%m-%d %H:%M:%S"),
            # 时间是不是报文自己带的。CSV 的 time 写坏时只能退回收到时刻，
            # 这种「不可信时间」不参与后面的陈旧广播判断
            "timeTrusted": dt is not None,
            "lowConfidence": conf is not None and conf < EV_CONFIDENCE_FLOOR,
            "source": source,
        }

    def feed(self, topic: str, payload: dict, recv_at: datetime | None = None,
             source: str = "live") -> dict | None:
        """topic 形如 Airguard-x9k2m/zone-n/data。返回本次生效的事件（或 None）。"""
        recv_at = recv_at or datetime.now()
        if not isinstance(payload, dict):
            return None
        parts = str(topic).split("/")
        zone_id = parts[1].strip().lower() if len(parts) >= 3 else ""
        if zone_id not in ZONE_NAME:
            return None
        if str(payload.get("zoneId", payload.get("zoneid", zone_id))).strip().lower() != zone_id:
            return None

        reading = self._reading(payload, zone_id, recv_at, source)
        if reading is None:
            return None
        if self._is_duplicate(dedupe_key(payload, zone_id, reading)):
            self.duplicates += 1
            return None

        self.messages += 1
        self.last_at = recv_at
        if source == "history":
            self.history_rows += 1
        else:
            self.live_rows += 1
        return self._apply(reading)

    # -- 状态机本体（逐行对应 web/script.js 的 applyEvent） -------------------
    def _apply(self, reading: dict) -> dict | None:
        zone_id = reading["zoneId"]
        rank = LEVELS[reading["level"]]["rank"]
        crowd = reading["crowdLevel"]
        ev = self.active.get(zone_id)

        # ---- 无事件：只有确实异常才建 ----
        if ev is None:
            if not is_abnormal(reading["level"], crowd):
                return None
            return self._create(reading)

        # ---- 乱序 / 迟到：旧消息不能覆盖更新后的最新状态 ----
        if reading["ts"] < ev["lastTs"]:
            self._log(ev, reading, "迟到/乱序消息，仅存档，不参与状态判断")
            return ev
        ev["lastTs"] = reading["ts"]

        # ---- 已恢复：迟到、重复消息都不回滚状态 ----
        if ev["state"] == EV_RECOVERED:
            if is_abnormal(reading["level"], crowd):
                return self._create(reading)      # 恢复之后又异常 → 这是新事件
            self._log(ev, reading, "事件已恢复，后续消息仅存档")
            return ev

        # ---- OPEN 待处理：数据只刷新严重度与理由，状态不动 ----
        if ev["state"] == EV_OPEN:
            ev["severity"] = severity_of(rank, crowd)
            ev["priorityReason"] = build_reason(reading)
            ev["actionKey"] = action_key_of(reading["level"], crowd)
            ev["actionOptions"] = EV_ACTIONS.get(ev["actionKey"], [])
            self._log(ev, reading, "待处理中的数据更新")
            return ev

        # ---- HANDLING 处理中：只能由新监测数据判定，按钮到不了这里 ----
        # ④ 每条干预后数据都单独记一行，⑤ 的结论另起一行 —— 报告里一步一步看得见
        self._log(ev, reading,
                  f'④ 收到干预后新数据：pm25 {reading["pm25"]} / co2 {reading["co2"]}')

        if reading["lowConfidence"]:
            if is_recovered_env(reading["level"], crowd):
                ev["manualReview"] = True
                ev["verifySamples"] = []
                ev["outcome"] = "低可信度数据，已标记人工复核"
            self._log(ev, reading, "⑤ 自动判定：数据低可信度，不参与恢复判定")
            return ev

        if is_recovered_env(reading["level"], crowd):
            ev["manualReview"] = False
            ev["relapseSamples"] = 0
            ev["verifySamples"].append({
                "time": reading["timeFull"], "pm25": reading["pm25"],
                "co2": reading["co2"], "crowdLevel": crowd, "level": reading["level"],
            })
            ev["state"] = EV_RECOVERED
            ev["recoveredAt"] = reading["timeFull"]
            ev["outcome"] = "已恢复"
            self._log(ev, reading, "⑤ 自动判定：达标 → 已恢复")
            return ev

        # 不达标：严重度高于干预那一刻才算恶化
        ev["verifySamples"] = []
        if severity_of(rank, crowd) > (ev["severityAtIntervention"] or 0):
            ev["relapseSamples"] += 1
            if ev["relapseSamples"] >= EV_RELAPSE_SAMPLES:
                ev["state"] = EV_OPEN
                ev["relapseSamples"] = 0
                ev["outcome"] = "干预无效，回退待处理"
                ev["severity"] = severity_of(rank, crowd)
                ev["priorityReason"] = build_reason(reading)
                ev["actionKey"] = action_key_of(reading["level"], crowd)
                ev["actionOptions"] = EV_ACTIONS.get(ev["actionKey"], [])
                self._log(ev, reading,
                          f"⑤ 自动判定：连续 {EV_RELAPSE_SAMPLES} 组恶化 → 回退 OPEN")
            else:
                ev["outcome"] = "仍需关注"
                self._log(ev, reading,
                          f"⑤ 自动判定：数据恶化 {ev['relapseSamples']}/{EV_RELAPSE_SAMPLES}，仍需关注")
        else:
            ev["relapseSamples"] = 0
            ev["outcome"] = "仍需关注"
            self._log(ev, reading, "⑤ 自动判定：未达标 → 仍需关注")
        return ev

    def _create(self, reading: dict) -> dict:
        rank = LEVELS[reading["level"]]["rank"]
        crowd = reading["crowdLevel"]
        self._seq += 1
        key = action_key_of(reading["level"], crowd)
        ev = {
            "event_id": f"evt-{reading['zoneId']}-{self._seq}-{int(reading['ts'])}",
            "zoneId": reading["zoneId"],
            "zoneName": ZONE_NAME.get(reading["zoneId"], reading["zoneId"]),
            "startedAt": reading["timeFull"],
            "type": event_type_of(rank, crowd),
            "priorityReason": build_reason(reading),
            "userActions": [],
            "verifySamples": [],
            "state": EV_OPEN,
            "interventionAt": None,
            "severityAtIntervention": None,
            "recoveredAt": None,
            "outcome": "待处理",
            "manualReview": False,
            "severity": severity_of(rank, crowd),
            "startSeverity": severity_of(rank, crowd),   # 建事件那一条的严重度，步骤①显示它
            "startTs": reading["ts"],                    # 建事件时刻，用于认领干预广播
            "startTimeTrusted": reading.get("timeTrusted", True),
            "actionKey": key,
            "actionOptions": EV_ACTIONS.get(key, []),
            "startReading": {"pm25": reading["pm25"], "co2": reading["co2"],
                             "crowdLevel": crowd, "level": reading["level"],
                             "time": reading["timeFull"], "source": reading["source"]},
            "lastTs": reading["ts"],
            "relapseSamples": 0,
            "log": [],
        }
        self._log(ev, reading, "监测捕获异常，事件建立")
        self.events.insert(0, ev)
        if len(self.events) > MAX_EVENTS:
            del self.events[MAX_EVENTS:]
        self.active[reading["zoneId"]] = ev
        return ev

    def _log(self, ev: dict, reading: dict, note: str) -> None:
        ev["log"].append({
            "time": reading["timeFull"],
            "levelLabel": LEVELS.get(reading["level"], {}).get("label", "—"),
            "crowdLevel": reading["crowdLevel"],
            "note": note,
        })
        if len(ev["log"]) > EV_LOG_MAX:
            del ev["log"][0]

    # -- 干预 ---------------------------------------------------------------
    def intervene(self, zone_id: str, actions, at: str | None = None,
                  actor: str = "web") -> dict | None:
        """提交干预动作。只有 OPEN 能提交；这里绝不会把状态置成 RECOVERED。"""
        ev = self.active.get(zone_id)
        if not ev or ev["state"] != EV_OPEN:
            return None
        actions = [a.strip() for a in (actions or [])
                   if isinstance(a, str) and a.strip()]
        clean = []
        for a in actions:
            if a not in clean:
                clean.append(a)
        if not clean:
            return None

        ev["state"] = EV_HANDLING
        ev["userActions"].append({
            "actions": clean,
            "at": at or datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
            "actor": actor,
        })
        ev["interventionAt"] = ev["userActions"][-1]["at"]
        ev["severityAtIntervention"] = ev["severity"]
        ev["verifySamples"] = []
        ev["relapseSamples"] = 0
        ev["manualReview"] = False
        ev["outcome"] = "干预已提交，等待新监测数据验证"
        note = (f'③ 三端同步「处理中」：{actor} 提交并广播 '
                f'{INTERVENTION_TOPIC.format(zone=zone_id)} · ' + " / ".join(clean))
        if ev.pop("matchedBy", "") == "zone+state":
            note += f'（广播事件号 {ev["remoteEventId"] or "—"} ↔ 本端 {ev["event_id"]}，按区域认领）'
        ev["log"].append({
            "time": ev["interventionAt"], "levelLabel": "", "crowdLevel": None,
            "note": note,
        })
        if len(ev["log"]) > EV_LOG_MAX:
            del ev["log"][0]
        return ev

    def receive_intervention(self, msg: dict) -> dict | None:
        """接收别端广播来的干预动作。

        认领条件（两者满足其一）：event_id 与本端事件号完全一致；或者——区域对得上、
        本端该区域事件还在 OPEN、且广播时刻不早于本端事件开始时间。

        为什么要放宽 event_id：报告端的事件是拿 CSV 历史行预填出来的，事件号里的
        自增段各端各算各的，跟 web / 移动端永远对不上。只认全等的话，真在 web 端点
        一次干预，报告这边只会记一条「没生效」，后面的 ③④⑤ 永远空着。
        放宽的只是「认领」，不放宽状态机：认领之后依旧只能由新监测数据判定恢复。
        """
        if not isinstance(msg, dict):
            return None
        zone_id = str(msg.get("zoneId", msg.get("zoneid", msg.get("zone", "")))).strip().lower()
        if zone_id not in ZONE_NAME:
            return None
        self.interventions += 1
        ev = self.active.get(zone_id)
        if ev is None:
            return None

        at = msg.get("at") or msg.get("time") or ""
        remote_id = str(msg.get("event_id") or "")
        same_id = bool(ev["event_id"]) and ev["event_id"] == remote_id
        fits = self._fits_event(ev, at)

        if ev["state"] == EV_OPEN and (same_id or fits):
            ev["matchedBy"] = "event_id" if same_id else "zone+state"
            ev["remoteEventId"] = remote_id
            return self.intervene(zone_id, msg.get("actions"), at=at,
                                  actor=msg.get("actor") or "remote")

        # 没应用上也要让人看得见：报告里明写「收到一条未生效的干预广播」及原因
        if ev["state"] != EV_OPEN:
            reason = f'本端该事件已是 {EV_LABEL.get(ev["state"], ev["state"])}，不再接受干预'
        else:
            reason = (f'广播时刻 {at or "（缺时间）"} 早于本端事件开始时间 '
                      f'{ev["startedAt"]}，对不上同一个事件')
        ev["lastRejectedIntervention"] = {
            "at": at, "actor": msg.get("actor", ""), "actions": msg.get("actions", []),
            "event_id": remote_id, "reason": reason,
        }
        return None

    @staticmethod
    def _fits_event(ev: dict, at: str) -> bool:
        """广播时刻是否落在本事件的存续区间内。

        判不了就认领（缺时间、时间解析不出、或者本事件的开始时间本身就是拿
        「收到时刻」顶替的）—— 只有两边时间都可信时，才拿时间先后挡陈旧广播。
        """
        dt = parse_time(at)
        if dt is None:
            return True
        if not ev.get("startTimeTrusted", True):
            return True
        return dt.timestamp() * 1000.0 >= ev.get("startTs", 0) - 1000.0

    # -- CSV 历史行预填 ------------------------------------------------------
    def seed_frame(self, df) -> int:
        """把 CSV 历史行按时间顺序灌进状态机，报告一打开就有完整事件流程。

        每条都走与实时报文完全相同的入口（校验、去重、状态机），
        所以历史行与实时数据不会两套标准；重复预填会被去重键挡掉。
        """
        if df is None or getattr(df, "empty", True):
            return 0
        has_ts = "ts" in df.columns
        rows = df.sort_values("ts", na_position="last") if has_ts else df
        added = 0
        for _, row in rows.iterrows():
            zone = str(row.get("zone", "")).strip().lower()
            ts = row.get("ts") if has_ts else None
            try:
                recv_at = ts.to_pydatetime() if ts is not None and not _is_nan(ts) else datetime.now()
            except Exception:                                      # noqa: BLE001
                recv_at = datetime.now()
            raw_time = row.get("time")
            payload = {
                "zoneId": zone,
                "pm25": _clean_num(row.get("pm25")),
                "co2": _clean_num(row.get("co2")),
                "crowdLevel": _clean_num(row.get("crowdLevel")),
                "time": "" if _is_nan(raw_time) else str(raw_time),
                # 稳定身份：CSV 行的去重键不能依赖「收到时刻」。time 列写坏时时间会
                # 退回收到时刻，而它每次预填都不同 —— 那等于每刷新一次就把历史重灌一遍
                "message_id": _csv_row_id(row, zone),
            }
            # 单行出问题只跳过这一行：一节报告不能因为某一行脏数据整块消失
            try:
                if self.feed(f"Airguard-x9k2m/{zone}/data", payload, recv_at=recv_at,
                             source="history"):
                    added += 1
            except Exception:                                      # noqa: BLE001
                self.skipped += 1
        return added


def _is_nan(v) -> bool:
    """None / NaN / NaT / pd.NA 都算「没有值」。

    pandas 的 NaT 既不等于自己、也不是 float：CSV 里时间写坏时 analysis.clean()
    会把 ts 整列变成 NaT，只认 float NaN 的话它会被当成有效时间戳传下去，
    最终在 NaT.timestamp() 上炸掉整个 D3 板块。
    """
    if v is None:
        return True
    try:
        return bool(v != v)
    except Exception:                                          # noqa: BLE001
        return False


def _csv_row_id(row, zone: str) -> str:
    """CSV 历史行的稳定身份：只由行内容决定，与预填时刻无关。

    内容完全相同的两行会被当成同一条（和实时侧按 message_id 去重同一口径）。
    """
    return "csv|" + "|".join(str(row.get(k)) for k in
                             ("time", "pm25", "co2", "crowdLevel")) + "|" + zone


def _clean_num(v):
    if _is_nan(v):
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


# ---------------------------------------------------------------------------
# 3. 报告板块渲染：一条事件一行 —— 谁有问题 / 采取了什么干预 / 新数据的结果
# ---------------------------------------------------------------------------

RESULT_TAG = {
    EV_OPEN: ("muted", "待处理"),
    EV_HANDLING: ("warn", "仍需关注"),
    EV_RECOVERED: ("ok", "已恢复"),
}

RESULT_HEADS = ["有问题的区域", "用户采取的干预措施", "后续新数据的结果"]
MAX_ROWS = 12


def _event_row(ev: dict) -> str:
    """一行就是一条事件：区域 / 干预动作 / 结果。"""
    tag_cls, label = RESULT_TAG.get(ev["state"], ("muted", ev["state"]))
    acts = ev["userActions"][-1]["actions"] if ev["userActions"] else []
    acts_txt = "、".join(esc(a) for a in acts) if acts else "—"
    return (f'      <tr><th scope="row">{esc(ev["zoneId"])}'
            f' <small>{esc(ev["zoneName"])}</small></th>'
            f'<td>{acts_txt}</td>'
            f'<td><span class="tag {tag_cls}">{label}</span></td></tr>')


def render_panel(engine: "D3Engine | None" = None, note: str = "") -> str:
    """板块 7 的正文：一张三列表，一行一条事件。"""
    if engine is None or not engine.events:
        nodata = f'<p class="note">{esc(note)}</p>' if note else ""
        return f"""    <p class="empty">还没有事件：只有收到<b>异常数据</b>（环境非正常，
      或人流达到拥挤及以上）才会建立事件，没有异常就一直空着。</p>
{nodata}"""

    heads = "".join(f"<th>{h}</th>" for h in RESULT_HEADS)
    rows = "\n".join(_event_row(ev) for ev in engine.events[:MAX_ROWS])
    more = (f'    <p class="note">另有 {len(engine.events) - MAX_ROWS} 条较早事件未列出。</p>\n'
            if len(engine.events) > MAX_ROWS else "")

    return f"""    <table class="score-table">
      <thead><tr>{heads}</tr></thead>
      <tbody>
{rows}
      </tbody>
    </table>
{more}"""
