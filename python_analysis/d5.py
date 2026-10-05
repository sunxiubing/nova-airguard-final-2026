#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
============================================================================
AirGuard D5 —— 固定规则 × 轻量 ML 辅助判断
============================================================================

要解决什么问题
--------------
AirGuard 已经有一套固定环境规则（pm25 / co2 阈值）。历史数据还能提供另一种
判断视角：拿本楼栋自己的历史分布，看新来的这组读数是不是「偏离常态」。
本模块把两者**并列**放在报告里，并给出一个组合裁决：

    固定规则判定  ──┐
                    ├──►  裁决策略：规则优先（ML 仅作参考，两者同屏可见）
    轻量 ML 判定  ──┘

规则与 ML 的依据不同——规则看**绝对阈值**，ML 看**本楼栋的历史分布**。
因此两者不一致本身就是值得分析的现象，不是「谁错了」。
裁决不等于删掉另一个：两种判断依据在报告里始终同时可见，裁决只给最终建议。

固定规则（写死在本文件常量里，页面上不可修改）
----------------------------------------------
    pm25 > 150            → 重度污染
    否则 pm25 > 75        → 轻度污染
    否则 co2  > 1500      → 通风不足风险
    否则                  → 正常

轻量 ML（不是深度学习）
-----------------------
按区域取本楼栋历史（data/history.csv 及 history_*.csv 快照，**只读**），
对 pm25 / co2 各算中位数与 MAD（稳健统计量），新读数换算成稳健 z 值：

    z = 0.6745 × (x − 中位数) / MAD

    · 该区域历史样本 < 5 条          → 「历史样本不足」，ML 不判定
    · max(|z_pm25|, |z_co2|) > 2.5   → 「与历史明显不同」
    · 否则                            → 「接近历史常态」

阈值 ML_SIGMA 是模块常量：现场核验时临时改它，ML 判定与「两者是否一致」
会跟着变（裁决仍是规则优先，不变）。

数据质量前置
------------
真实数据不会总是干净的，脏数据不得让规则算出错误状态：

    · 缺失：pm25 / co2 缺字段或非数值 → 判「数据不足」，规则与 ML 都不出结论
    · 离群：pm25 ∉ [0, 1000] 或 co2 ∉ [400, 5000] → 拦下并标记为超量程
    · 时钟：time 缺失 / 格式错误 / 比该区域上一条更早（时间倒流）
           → 标注出来，改用接收时刻排序，读数照常判定

本模块只读历史数据，**不写** data/ 下的任何文件，也不改 history.csv。
============================================================================
"""

from __future__ import annotations

import html
import math
import re
from datetime import datetime
from pathlib import Path

import pandas as pd

BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "data"

# ---------------------------------------------------------------------------
# 0. 常量：固定规则阈值 / ML 参数 / 量程 / 裁决策略
# ---------------------------------------------------------------------------

RULE_PM25_CRITICAL = 150.0      # pm25 > 150 → 重度污染
RULE_PM25_WARNING = 75.0        # pm25 > 75  → 轻度污染
RULE_CO2_SERIOUS = 1500.0       # co2  > 1500 → 通风不足风险

ML_SIGMA = 2.5                  # 稳健 z 阈值：超过它才算「偏离历史常态」
ML_MIN_SAMPLES = 5              # 少于这么多条历史样本，ML 不判定

PM25_RANGE = (0.0, 1000.0)      # 量程：超出→标「存疑」照算（缺字段才拦下）
CO2_RANGE = (400.0, 5000.0)     # 室内 co2 不可能低于室外本底 400ppm

VERDICT_POLICY = "rule-first"   # 裁决策略：规则优先（ML 只作参考）
VERDICT_LABEL = "规则优先"

RECORDS_LIMIT = 400             # 内存里最多留多少条实时判定（不落盘）

ZONES = [
    ("zone-n", "宿舍区", "#2f7cd6"),
    ("zone-s", "教学区", "#e08b21"),
    ("zone-w", "食堂区", "#26a177"),
]
ZONE_NAME = {z: n for z, n, _ in ZONES}
ZONE_COLOR = {z: c for z, _, c in ZONES}

LEVEL_ORDER = ["正常", "通风不足风险", "轻度污染", "重度污染"]


def zone_name(zone_id: str) -> str:
    return ZONE_NAME.get(zone_id, zone_id)


def tag_class(label: str) -> str:
    """判定标签 → 报告页的配色类（与 analysis.level_class 同一套色）"""
    return {
        "正常": "ok", "接近历史常态": "ok",
        "通风不足风险": "warn", "轻度污染": "warn", "与历史明显不同": "warn",
        "重度污染": "bad",
        "数据不足": "muted", "历史样本不足": "muted", "未判定": "muted",
    }.get(label, "muted")


# ---------------------------------------------------------------------------
# 1. 固定规则
# ---------------------------------------------------------------------------

def rule_judge(pm25, co2) -> dict:
    """固定规则判定。阈值全部来自上面的常量，页面与接口都不提供修改入口。"""
    if pm25 is None or co2 is None:
        return {"label": "数据不足", "detail": "pm25 / co2 不完整，规则不出结论"}

    if pm25 > RULE_PM25_CRITICAL:
        return {"label": "重度污染",
                "detail": f"pm25 {pm25:g} > {RULE_PM25_CRITICAL:g}"}
    if pm25 > RULE_PM25_WARNING:
        return {"label": "轻度污染",
                "detail": f"pm25 {pm25:g} > {RULE_PM25_WARNING:g}"}
    if co2 > RULE_CO2_SERIOUS:
        return {"label": "通风不足风险",
                "detail": f"pm25 {pm25:g} ≤ {RULE_PM25_WARNING:g}，但 co2 {co2:g} > {RULE_CO2_SERIOUS:g}"}
    return {"label": "正常",
            "detail": f"pm25 {pm25:g} ≤ {RULE_PM25_WARNING:g} 且 co2 {co2:g} ≤ {RULE_CO2_SERIOUS:g}"}


# ---------------------------------------------------------------------------
# 2. 轻量 ML：本楼栋历史分布
# ---------------------------------------------------------------------------

def _to_num(v):
    """宽松取数：数字、数字字符串都认；取不到返回 None"""
    if v is None:
        return None
    if isinstance(v, (int, float)):
        f = float(v)
        return f if math.isfinite(f) else None
    s = str(v).strip()
    if not s:
        return None
    try:
        f = float(s)
    except ValueError:
        return None
    return f if math.isfinite(f) else None


def _median(values: list) -> float:
    s = sorted(values)
    n = len(s)
    mid = n // 2
    return s[mid] if n % 2 else (s[mid - 1] + s[mid]) / 2.0


def _metric_stats(values: list) -> dict:
    """中位数 + MAD（稳健统计量，少量样本也比均值/标准差抗异常值）"""
    if not values:
        return {"n": 0, "median": None, "mad": None, "min": None, "max": None}
    med = _median(values)
    mad = _median([abs(v - med) for v in values])
    return {"n": len(values), "median": med, "mad": mad,
            "min": min(values), "max": max(values), "values": sorted(values)}


def _robust_z(x: float, st: dict):
    """稳健 z：mad 为 0（历史取值过于集中）时给不出有意义的尺度，返回 None"""
    if st["median"] is None or not st["mad"]:
        return None
    return 0.6745 * (x - st["median"]) / st["mad"]


def baseline_files() -> list:
    """ML 用到的历史文件：data/history.csv + history_*.csv + archive/*.csv（只读）"""
    files = []
    main = DATA_DIR / "history.csv"
    if main.exists():
        files.append(main)
    files += sorted(p for p in DATA_DIR.glob("history_*.csv"))
    files += sorted(p for p in (DATA_DIR / "archive").glob("history_*.csv"))
    return files


def load_baseline() -> dict:
    """扫一遍历史文件，按区域统计 pm25 / co2 分布。

    重复行（同一份数据被复制成多份快照）先去掉，避免同一时刻被数两次。
    全程只读；本模块不写 data/ 下的任何文件。
    """
    frames = []
    used = []
    for path in baseline_files():
        try:
            df = pd.read_csv(path, encoding="utf-8-sig")
        except Exception:                                   # noqa: BLE001
            continue
        if "zone" not in df.columns:
            continue
        for col in ("pm25", "co2"):
            if col in df.columns:
                df[col] = pd.to_numeric(df[col], errors="coerce")
        keep = [c for c in ("time", "zone", "pm25", "co2") if c in df.columns]
        frames.append(df[keep])
        used.append(path.name)

    if not frames:
        return {"zones": {}, "files": used, "rows": 0}

    all_df = pd.concat(frames, ignore_index=True)
    if "time" in all_df.columns:
        all_df = all_df.drop_duplicates(subset=["time", "zone", "pm25", "co2"])

    zones = {}
    for zone_id, _, _ in ZONES:
        sub = all_df[all_df["zone"].astype(str).str.strip() == zone_id]
        pm = [v for v in (_to_num(v) for v in sub.get("pm25", [])) if v is not None]
        co = [v for v in (_to_num(v) for v in sub.get("co2", [])) if v is not None]
        zones[zone_id] = {"pm25": _metric_stats(pm), "co2": _metric_stats(co)}

    # 判「历史本身是否以异常为主」：ml 的原因说明要用，规则阈值这里独立重算一遍
    abnormal = 0
    total = 0
    for zone_id in zones:
        sub = all_df[all_df["zone"].astype(str).str.strip() == zone_id]
        for _, row in sub.iterrows():
            pm = _to_num(row.get("pm25"))
            co = _to_num(row.get("co2"))
            if pm is None or co is None:
                continue
            total += 1
            if rule_judge(pm, co)["label"] != "正常":
                abnormal += 1

    return {"zones": zones, "files": used, "rows": int(len(all_df)),
            "abnormal": abnormal, "total": total}


def ml_judge(zone_id: str, pm25, co2, baseline: dict) -> dict:
    """轻量 ML 判定：这组读数离本楼栋历史常态有多远。"""
    st = (baseline or {}).get("zones", {}).get(zone_id)
    if not st:
        return {"label": "历史样本不足", "detail": "该区域没有历史数据", "z": {}}

    n_pm, n_co = st["pm25"]["n"], st["co2"]["n"]
    if min(n_pm, n_co) < ML_MIN_SAMPLES:
        return {"label": "历史样本不足",
                "detail": f"{zone_name(zone_id)}历史样本 {min(n_pm, n_co)} 条（< {ML_MIN_SAMPLES}），ML 不判定",
                "z": {}}

    z_pm = _robust_z(pm25, st["pm25"]) if pm25 is not None else None
    z_co = _robust_z(co2, st["co2"]) if co2 is not None else None
    zs = {"pm25": z_pm, "co2": z_co}
    scored = {k: v for k, v in zs.items() if v is not None}
    if not scored:
        return {"label": "历史样本不足", "detail": "历史取值过于集中，稳健 z 无意义", "z": zs}

    driver = max(scored, key=lambda k: abs(scored[k]))
    worst = scored[driver]
    hist = st[driver]
    direction = "高于" if worst > 0 else "低于"
    detail = (f"{driver} 稳健偏离 {abs(worst):.2f}σ（{direction}历史中位 {hist['median']:g}，"
              f"MAD {hist['mad']:g}，区间 {hist['min']:g}~{hist['max']:g}）")

    if abs(worst) > ML_SIGMA:
        return {"label": "与历史明显不同", "detail": detail, "z": zs, "driver": driver}
    return {"label": "接近历史常态", "detail": detail, "z": zs, "driver": driver}


def inconsistency_reason(zone_id: str, ml: dict, baseline: dict, rec) -> str:
    """两者不一致时，说明可能的原因（D5 要求：不把任何一方直接判为『错误』）"""
    st = (baseline or {}).get("zones", {}).get(zone_id, {}).get("pm25", {})
    reasons = []
    n = st.get("n") or 0
    if n < 10:
        reasons.append(f"历史样本偏少（{n} 条），中位数与 MAD 都还不够稳")
    total = (baseline or {}).get("total") or 0
    abnormal = (baseline or {}).get("abnormal") or 0
    if total and abnormal / total >= 0.4:
        reasons.append(f"历史本身包含异常（{abnormal}/{total} 条按固定规则已属异常），"
                       f"ML 学到的『常态』被异常时段带偏")
    hist = st.get("min"), st.get("max")
    if rec.get("pm25") is not None and None not in hist:
        if not (hist[0] <= rec["pm25"] <= hist[1]):
            reasons.append(f"本次 pm25 {rec['pm25']:g} 超出该区域历史区间 "
                           f"{hist[0]:g}~{hist[1]:g}，当前环境模式可能已经变化")
    if not reasons:
        reasons.append("两种判据的依据本就不同：规则看绝对阈值，ML 看本楼栋历史分布，"
                       "同一个读数完全可能在一边正常、在另一边偏离")
    return "；".join(reasons) + "。"


# ---------------------------------------------------------------------------
# 3. 数据质量前置
# ---------------------------------------------------------------------------

_TIME_RE = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$")


def parse_time(raw):
    """宽松解析报文时间；解析不出来返回 None（调用方改用接收时刻）"""
    if raw is None:
        return None
    if isinstance(raw, datetime):
        return raw
    if isinstance(raw, (int, float)):
        n = float(raw)
        if n > 1e11:
            n /= 1000.0
        try:
            return datetime.fromtimestamp(n)
        except (OverflowError, OSError, ValueError):
            return None
    s = str(raw).strip()
    if not s:
        return None
    m = _TIME_RE.match(s)
    if m:
        y, mo, d, h, mi, sec = (int(x) if x else 0 for x in
                                (m.group(1), m.group(2), m.group(3),
                                 m.group(4), m.group(5), m.group(6) or 0))
        try:
            return datetime(y, mo, d, h, mi, sec)
        except ValueError:
            return None
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y/%m/%d %H:%M:%S", "%Y-%m-%dT%H:%M:%S", "%H:%M:%S"):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.replace(year=datetime.now().year, month=datetime.now().month,
                              day=datetime.now().day) if fmt == "%H:%M:%S" else dt
        except ValueError:
            continue
    return None


def validate(payload: dict, prev_dt=None) -> dict:
    """数据质量前置：缺失 / 离群 / 时钟。返回可用数值 + 问题清单。

    分两档，处理方式不同：
      · blocking（缺字段 / 非数值 / 时间无法解析）：不足以支撑判定，规则、ML 都不出结论；
      · suspect（数值超出物理量程）：值可疑但仍是「一个数」，照算并全程标注「存疑」，
        裁决文字也会写明结论仅供参考 —— 直接丢掉会让报告凭空少一行，反而看不出问题。
    """
    blocking, suspect, notes = [], [], []

    pm25 = _to_num(payload.get("pm25"))
    co2 = _to_num(payload.get("co2"))
    if pm25 is None:
        blocking.append("pm25 缺失或非数值")
    if co2 is None:
        blocking.append("co2 缺失或非数值")
    if pm25 is not None and not (PM25_RANGE[0] <= pm25 <= PM25_RANGE[1]):
        suspect.append(f"pm25 {pm25:g} 超出量程 {PM25_RANGE[0]:g}~{PM25_RANGE[1]:g}（疑似离群值）")
    if co2 is not None and not (CO2_RANGE[0] <= co2 <= CO2_RANGE[1]):
        suspect.append(f"co2 {co2:g} 超出量程 {CO2_RANGE[0]:g}~{CO2_RANGE[1]:g}（疑似离群值）")

    raw_time = payload.get("time", payload.get("ts", payload.get("timestamp")))
    dt = parse_time(raw_time)
    clock = "正常"
    if raw_time is None or str(raw_time).strip() == "":
        clock = "时间缺失"
        notes.append("报文没带时间，改用接收时刻")
    elif dt is None:
        clock = "时间格式错误"
        notes.append(f"时间「{raw_time}」解析不了，改用接收时刻")
    elif prev_dt is not None and dt < prev_dt:
        clock = "时间倒流"
        notes.append(f"时间 {dt:%H:%M:%S} 早于该区域上一条 {prev_dt:%H:%M:%S}，按接收时刻处理")

    if suspect:
        notes.append("；".join(suspect) + "，结论仅供参考")

    return {"pm25": pm25, "co2": co2, "dt": dt if dt and clock == "正常" else None,
            "raw_time": raw_time, "clock": clock, "blocking": blocking,
            "suspect": suspect, "notes": notes, "ok": not blocking}


# ---------------------------------------------------------------------------
# 4. 协同裁决 —— 策略写在代码里，可解释、可重复
# ---------------------------------------------------------------------------

def verdict(quality_ok: bool, rule: dict, ml: dict) -> dict:
    """组合裁决：规则优先。

    规则给出的环境结论就是最终建议；ML 只在旁边标注一致 / 不一致，
    既不参与打分，也不会顶替规则。数据不合格时不给建议（等一条好数据）。
    """
    consistent = None                # None = 无从比较（数据不足或 ML 没判定）
    if quality_ok and rule["label"] not in ("数据不足",) and ml["label"] in ("接近历史常态", "与历史明显不同"):
        consistent = (rule["label"] == "正常") == (ml["label"] == "接近历史常态")

    if not quality_ok:
        final = "数据不足"
        text = "数据校验未通过，规则与 ML 都不出结论，裁决暂缓"
    elif ml["label"] == "历史样本不足":
        final = rule["label"]
        text = f"按固定规则定为「{rule['label']}」；ML 无足够历史，本次不参与对照"
    elif consistent:
        final = rule["label"]
        text = f"规则与 ML 一致，最终建议「{rule['label']}」"
    else:
        final = rule["label"]
        text = (f"规则与 ML 不一致：规则判「{rule['label']}」、ML 判「{ml['label']}」；"
                f"按 {VERDICT_LABEL} 策略，最终建议仍取规则结论「{rule['label']}」")
    return {"policy": VERDICT_POLICY, "final": final, "text": text, "consistent": consistent}


# ---------------------------------------------------------------------------
# 5. 实时判定引擎（内存态，不落盘）
# ---------------------------------------------------------------------------

class D5Engine:
    """收一条报文 → 校验 → 规则判定 → ML 判定 → 裁决 → 存进内存列表。"""

    def __init__(self, baseline: dict | None = None, limit: int = RECORDS_LIMIT):
        self.baseline = baseline if baseline is not None else load_baseline()
        self.limit = limit
        self.records: list = []          # 旧 → 新
        self.received = 0                # 收到的数据报文总数（含被拦下的）
        self.rejected = 0                # 被数据质量拦下的条数
        self.duplicates = 0              # 重复到达、只算一次的条数
        self.history = 0                 # 其中来自 CSV 历史行的条数
        self.live = 0                    # 其中来自实时 MQTT 的条数
        self.last_at = None              # 最近一条的接收时刻
        self.note = ""                   # 状态条上的一句话（由调用方维护）
        self._keys: set = set()          # 去重键，见 _dedupe_key()

    def _dedupe_key(self, zone_id: str, q: dict, payload: dict, recv_at: datetime) -> str:
        """同一条消息多次到达只生效一次。有 message_id 就用它，
        否则用「区域 + 时间 + 两个读数」——CSV 历史行与当初那条报文会算出同一个键，
        所以重复预填不会把同一行灌进去两次。

        时间一律用原始报文字段重新解析（不能借 validate 的结果：它会因为「时间倒流」
        把 dt 清空，导致同一行第二次预填算出另一个键、被当成新记录）。
        """
        mid = payload.get("message_id", payload.get("messageId"))
        if mid:
            return f"mid:{zone_id}:{mid}"
        t = parse_time(q["raw_time"]) or recv_at
        return f"{zone_id}|{t:%Y-%m-%d %H:%M:%S}|{q['pm25']}|{q['co2']}"

    def feed(self, topic: str, payload: dict, recv_at: datetime | None = None,
             source: str = "live") -> dict | None:
        """topic 形如 Airguard-x9k2m/zone-n/data；payload 为已解析的 JSON 对象。

        source="history" 表示这条来自 CSV 历史行（批量预填），"live" 表示实时 MQTT。
        """
        recv_at = recv_at or datetime.now()

        parts = str(topic).split("/")
        zone_id = parts[1].strip().lower() if len(parts) >= 3 else ""
        if zone_id not in ZONE_NAME:
            return None                  # 认不出区域：与四端同一口径，直接丢（不计入已收）
        if str(payload.get("zoneId", payload.get("zoneid", zone_id))).strip().lower() != zone_id:
            return None                  # 主题与报文区域对不上，串区报文

        prev = next((r for r in reversed(self.records) if r["zone"] == zone_id), None)
        prev_dt = prev["sort_dt"] if prev else None
        q = validate(payload, prev_dt)

        key = self._dedupe_key(zone_id, q, payload, recv_at)
        if key in self._keys:
            if source == "live":
                self.duplicates += 1    # 只统计实时侧的真重复；历史行重复预填是内部行为
            return None
        self._keys.add(key)

        self.received += 1
        self.last_at = recv_at
        if source == "history":
            self.history += 1
        else:
            self.live += 1

        rule = rule_judge(q["pm25"], q["co2"])
        ml = ml_judge(zone_id, q["pm25"], q["co2"], self.baseline) if q["ok"] \
            else {"label": "未判定", "detail": "数据校验未通过，ML 不判定", "z": {}}
        vd = verdict(q["ok"], rule, ml)
        if q["suspect"]:
            vd["text"] += "（该条 " + "、".join(q["suspect"]) + "，数值存疑，结论仅供参考）"

        sort_dt = q["dt"] or recv_at
        rec = {
            "at": recv_at.strftime("%H:%M:%S"),
            "sort_dt": sort_dt,
            "zone": zone_id,
            "zoneName": zone_name(zone_id),
            "pm25": q["pm25"], "co2": q["co2"],
            "crowdLevel": _to_num(payload.get("crowdLevel", payload.get("crowdlevel"))),
            "msgTime": (q["dt"] or recv_at).strftime("%H:%M:%S"),
            "clock": q["clock"],
            "issues": q["blocking"] + q["notes"],
            "note": str(payload.get("note", "") or "").strip()[:60],
            "source": source,
            "quality": "不合格" if not q["ok"] else ("存疑" if q["suspect"] else "合格"),
            "rule": rule, "ml": ml, "verdict": vd,
        }
        if not q["ok"]:
            self.rejected += 1
        self.records.append(rec)
        if len(self.records) > self.limit:
            del self.records[: len(self.records) - self.limit]
        return rec

    def seed_frame(self, df) -> int:
        """把 CSV 里的历史行批量灌进来：报告一打开就能看到每条的规则 / ML 判定。

        只读 DataFrame，不写任何文件；同一行重复灌会被去重键挡掉。
        返回这一次真正新加进去的条数。
        """
        if df is None or getattr(df, "empty", True):
            return 0
        cols = {c: c for c in df.columns}
        has_ts = "ts" in cols
        rows = df.sort_values("ts", na_position="last") if has_ts else df
        added = 0
        for _, row in rows.iterrows():
            zone = str(row.get("zone", "")).strip().lower()
            raw_time = row.get("time")
            ts = row.get("ts") if has_ts else None
            try:
                recv_at = ts.to_pydatetime() if ts is not None and not pd.isna(ts) else datetime.now()
            except Exception:                                  # noqa: BLE001
                recv_at = datetime.now()
            payload = {
                "zoneId": zone,
                "pm25": row.get("pm25"),
                "co2": row.get("co2"),
                "crowdLevel": row.get("crowdLevel"),
                "time": "" if raw_time is None or (isinstance(raw_time, float) and pd.isna(raw_time))
                        else str(raw_time),
                "note": CSV_NOTE,
                # 稳定身份：去重键不能依赖「收到时刻」。time 列写坏时 _dedupe_key
                # 会退回收到时刻，而它每次预填都不同 —— 那等于每刷新一次就把历史重灌一遍
                "message_id": "csv|" + "|".join(str(row.get(k)) for k in
                                                ("time", "pm25", "co2", "crowdLevel")) + "|" + zone,
            }
            # 数值型 NaN 在 JSON 里没有对应，先转成 None，交给 validate 按「缺失」处理
            for k in ("pm25", "co2", "crowdLevel"):
                v = payload[k]
                if v is None or (isinstance(v, float) and pd.isna(v)):
                    payload[k] = None
                else:
                    try:
                        payload[k] = float(v)
                    except (TypeError, ValueError):
                        payload[k] = None
            if self.feed(f"Airguard-x9k2m/{zone}/data", payload, recv_at=recv_at, source="history"):
                added += 1
        return added


# ---------------------------------------------------------------------------
# 6. 报告板块渲染（返回 HTML 片段，塞进 report.html 的板块 6）
# ---------------------------------------------------------------------------

def esc(v) -> str:
    return html.escape(str(v), quote=True)


def _num(v, digits=0) -> str:
    if v is None:
        return "—"
    return f"{v:.{digits}f}" if isinstance(v, float) else str(v)


def _tag(label: str) -> str:
    return f'<span class="tag {tag_class(label)}">{esc(label)}</span>'


def _kpi_tiles(items) -> str:
    return "\n        ".join(
        f'<div class="kpi"><div class="k">{esc(k)}</div><div class="v">{v}<small>{s}</small></div></div>'
        for k, v, s in items
    )


def _baseline_table(baseline: dict) -> str:
    rows = []
    for zone_id, name, color in ZONES:
        st = (baseline or {}).get("zones", {}).get(zone_id, {})
        pm, co = st.get("pm25", {}), st.get("co2", {})
        rows.append(f"""      <tr>
        <th scope="row"><span class="dot" style="background:{color}"></span>{esc(name)}</th>
        <td>{pm.get('n', 0)}</td>
        <td>{_num(pm.get('median'), 1)}</td>
        <td>{_num(pm.get('mad'), 1)}</td>
        <td>{_num(pm.get('min'), 0)} ~ {_num(pm.get('max'), 0)}</td>
        <td>{co.get('n', 0)}</td>
        <td>{_num(co.get('median'), 0)}</td>
        <td>{_num(co.get('mad'), 0)}</td>
      </tr>""")
    return "\n".join(rows)


CSV_NOTE = "CSV 历史行"           # 预填历史行时写进 note 的标记，用来和人工构造样本区分


def _is_planted(rec: dict) -> bool:
    """这条是不是「构造测试样本」（而不是真实的 CSV 历史行 / 现场报文）"""
    return bool(rec.get("note")) and rec.get("note") != CSV_NOTE


def _records_table(records: list) -> str:
    rows = []
    for r in records:
        z = r["ml"].get("z", {})
        zs = " / ".join(f"{k} {v:+.2f}σ" for k, v in z.items() if v is not None) or "—"
        if r["verdict"]["consistent"] is None:
            mark = '<span class="tag muted">无从比较</span>'
        elif r["verdict"]["consistent"]:
            mark = '<span class="tag ok">一致</span>'
        else:
            mark = '<span class="tag warn">不一致</span>'
        if r.get("note") == CSV_NOTE:
            mark_note = '<br><span class="tag muted">CSV 历史</span>'
        elif _is_planted(r):
            mark_note = f'<br><span class="tag muted" title="{esc(r["note"])}">构造样本</span>'
        else:
            mark_note = '<br><span class="tag muted">实时</span>'
        qcls = {"合格": "ok", "存疑": "warn", "不合格": "bad"}.get(r["quality"], "muted")
        qtips = esc("；".join(r["issues"])) if r["issues"] else ""
        rows.append(f"""      <tr>
        <td>{esc(r['at'])}{mark_note}</td>
        <td><span class="dot" style="background:{ZONE_COLOR[r['zone']]}"></span>{esc(r['zoneName'])}</td>
        <td>{_num(r['pm25'], 1)}</td>
        <td>{_num(r['co2'], 0)}</td>
        <td><span class="tag {qcls}"{' title="' + qtips + '"' if qtips else ''}>{esc(r['quality'])}</span></td>
        <td>{_tag(r['rule']['label'])}</td>
        <td>{_tag(r['ml']['label'])}</td>
        <td>{mark}</td>
        <td><b>{esc(r['verdict']['final'])}</b></td>
        <td class="muted-cell">{esc(zs)}</td>
      </tr>""")
    return "\n".join(rows)


def render_panel(engine: "D5Engine | None" = None, mqtt_note: str = "") -> str:
    """板块 6 的正文。engine 为空 / 还没收到报文时给一张「等待中」的说明卡。"""
    if engine is None or not engine.records:
        note = f'<p class="note">{esc(mqtt_note)}</p>' if mqtt_note else ""
        return f"""    <p class="empty">还没有收到 MQTT 报文，判定结果将在第一条
      <code>Airguard-x9k2m/&lt;区域&gt;/data</code> 报文到达后自动出现（本页每秒自检一次，无需手动刷新）。</p>
{note}
    <p class="lead">规则与 ML 的对照会在这里同屏展示：每收到一条新数据，后台同时算出
      <b>固定规则判定</b>（pm25 / co2 绝对阈值）与 <b>轻量 ML 判定</b>（本楼栋历史分布），
      再给出是否一致与最终裁决。两种判据始终并列可见，裁决不会删掉任何一方。</p>
    <p class="lead">想立刻看效果：先开着 <code>实时报告.bat</code>，再双击 <code>D5演示报文.bat</code> ——
      它会发一条<b>规则判正常、却明显偏离本楼栋历史常态</b>的构造样本（报文里带
      <code>note</code> 字段，页面上会标注「构造样本」），两种判据的对照会立刻出现在这里。</p>"""

    last = engine.records[-1]
    b = engine.baseline or {}
    z = last["ml"].get("z", {})
    zs = " / ".join(f"{k} {v:+.2f}σ" for k, v in z.items() if v is not None) or "—"

    # 「值得分析」的案例：优先挑数据合格的不一致条，其次才轮到存疑的；
    # 同为合格时取偏离度（|z| 之和）最大的那条，展示效果最直观
    incomp_pool = [r for r in engine.records if r["verdict"]["consistent"] is False]
    if incomp_pool:
        incomp = max(
            incomp_pool,
            key=lambda r: (r["quality"] == "合格",
                           sum(abs(v) for v in r["ml"].get("z", {}).values() if v is not None)),
        )
    else:
        incomp = None

    kpis = _kpi_tiles([
        ("最新一条", f'{esc(last["zoneName"])} · {esc(last["at"])}', f'报文时间 {esc(last["msgTime"])}'),
        ("固定规则判定", _tag(last["rule"]["label"]), f'（{esc(last["rule"]["detail"])}）'),
        ("ML 判定", _tag(last["ml"]["label"]), f'（{esc(last["ml"]["detail"])}）'),
        ("两者是否一致",
         ('<span class="tag warn">不一致</span>' if last["verdict"]["consistent"] is False
          else '<span class="tag ok">一致</span>' if last["verdict"]["consistent"] is True
          else '<span class="tag muted">无从比较</span>'),
         f'稳健 z：{esc(zs)}'),
    ])
    d5_stat = (f'共 {engine.received} 条（CSV 历史 {engine.history} · 实时 MQTT {engine.live}）'
               f' · 拦下 {engine.rejected} 条不合格'
               + (f' · 重复 {engine.duplicates} 条只算一次' if engine.duplicates else "")
               + (f' · 最近 {esc(engine.last_at.strftime("%H:%M:%S"))}' if engine.last_at else ""))

    reason_block = ""
    if incomp:
        reason_block = f"""
    <h3 class="sub-head">「值得分析」的案例：规则与 ML 不一致</h3>
    <p class="lead">{esc(incomp['at'])} · {esc(incomp['zoneName'])} ·
       pm25 {_num(incomp['pm25'], 1)} · co2 {_num(incomp['co2'], 0)}：
       固定规则判「<b>{esc(incomp['rule']['label'])}</b>」（{esc(incomp['rule']['detail'])}），
       ML 判「<b>{esc(incomp['ml']['label'])}</b>」（{esc(incomp['ml']['detail'])}）。</p>
    <p class="verdict"><b>可能原因</b> · {esc(inconsistency_reason(incomp['zone'], incomp['ml'], b, incomp))}
       两种判断依据不同，结果不一致本身不是错误，而是值得记录的现象。{
        f'（本条为<b>构造测试样本</b>：{esc(incomp["note"])}）' if _is_planted(incomp) else ''}
       {f'（该条数据质量存疑：{esc("；".join(incomp["issues"]))}）' if incomp['quality'] != '合格' else ''}</p>"""
    else:
        reason_block = """
    <h3 class="sub-head">「值得分析」的案例：规则与 ML 不一致</h3>
    <p class="empty">截至当前，收到的报文里还没有出现规则与 ML 不一致的组合。
      想现场演示这种情形，可双击 <code>D5演示报文.bat</code>：它会发一条
      <b>规则判正常、但明显偏离本楼栋历史常态</b>的读数（构造测试样本，已明确标注）。</p>"""

    return f"""    <div class="kpis">
        {kpis}
    </div>
    <p class="verdict"><b>裁决（{esc(VERDICT_LABEL)}）</b> · {esc(last['verdict']['text'])}</p>
    <p class="lead">裁决策略写在程序里：<code>{esc(VERDICT_POLICY)}</code> ——
      规则给出最终建议，ML 只作参考并标注一致 / 不一致；数据校验不通过时两边都不出结论，裁决暂缓。
      固定规则阈值（pm25 &gt; {RULE_PM25_CRITICAL:g} / &gt; {RULE_PM25_WARNING:g}、co2 &gt; {RULE_CO2_SERIOUS:g}）
      与 ML 阈值（稳健 z &gt; {ML_SIGMA}）都是代码常量，页面上不提供修改入口。{esc(d5_stat)}。
      想复现「规则与 ML 不一致」的对照，双击目录里的 <code>D5演示报文.bat</code> 即可重发同一组构造读数。</p>

    <h3 class="sub-head">逐条判定流水（CSV 历史行 + 实时报文，全部列出）</h3>
    <p class="lead">共 {len(engine.records)} 条，按时间先后排列；每条的固定规则判定、ML 判定、
      是否一致、裁决都能对上。数据质量一列：合格 / 存疑（数值超量程，照算但结论仅供参考）/ 不合格（缺字段，不出结论）。</p>
    <table class="score-table">
      <thead>
        <tr><th>接收</th><th>区域</th><th>pm25</th><th>co2</th><th>数据质量</th>
            <th>固定规则</th><th>ML 判定</th><th>是否一致</th><th>裁决</th><th>ML 偏离度</th></tr>
      </thead>
      <tbody>
{_records_table(engine.records)}
      </tbody>
    </table>
{reason_block}

    <h3 class="sub-head">ML 基线：本楼栋历史分布（只读）</h3>
    <p class="lead">来源：{esc('、'.join(b.get('files', [])[:6]) or '—')}
      （共 {b.get('rows', 0)} 条去重后记录）。ML 用中位数 + MAD 描述每个区域自己的常态，
      新读数换算成稳健 z 值后与阈值 {ML_SIGMA} 比较。样本不足 {ML_MIN_SAMPLES} 条的区域不判定。</p>
    <table class="score-table">
      <thead>
        <tr><th>区域</th><th>pm25 样本</th><th>pm25 中位</th><th>pm25 MAD</th><th>pm25 区间</th>
            <th>co2 样本</th><th>co2 中位</th><th>co2 MAD</th></tr>
      </thead>
      <tbody>
{_baseline_table(b)}
      </tbody>
    </table>"""
