#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
============================================================================
AirGuard D3【干预—验证—恢复】现场演示脚本
============================================================================

它做什么
--------
按剧本往 Broker 灌监测数据，把事件状态机整条链推一遍：
无事件 → OPEN →（你在页面点干预）→ HANDLING → 第 1 条达标数据 → RECOVERED，
中间穿插重复消息、迟到消息、干预无效回退三个健壮性演示。

脚本**只发数据，不改任何状态**——状态全部由四端各自的客户端根据收到的
报文自行判定。所以终端里看到的推进过程，就是四端真实跑出来的结果。

同时它订阅 Airguard/intervention/+，你在任一端点了【执行干预】，
终端会立刻打印出那条广播，用来确认四端确实收敛到了同一个状态。

用法
----
    venv\\Scripts\\python.exe evidence\\D3\\d3-demo.py

    一切正常的话，按提示在页面上操作即可；脚本检测到干预广播会自动往下走。
    不想等某一步，直接按回车跳过。

    venv\\Scripts\\python.exe evidence\\D3\\d3-demo.py --auto 4
        --auto N：每步之间只停 N 秒，不等回车也不等干预（录屏 / 快速过一遍用）

前置条件
--------
1. Mosquitto Broker 已启动（websocket 8085 / tcp 1885）
2. 至少打开一个前端页面：
       web/index.html      Web 监测台
       map3d/index.html    3D 校园沙盘
       mobile/index.html   移动端
   三个都开最好——这个演示要看的正是「四端同时变」。
   小程序端要用微信开发者工具打开 mobile/ 目录。
3. 页面必须先连上 Broker（右上角状态变成「已连接」），再跑本脚本。
   顺序反了也不要紧：干预广播是 retain 的，但报文流不是，重跑一次即可。
============================================================================
"""

from __future__ import annotations

import argparse
import json
import sys
import threading
import time
from datetime import datetime, timedelta

import paho.mqtt.client as mqtt

# Windows 终端默认按本地代码页输出，中文会变乱码；显式切成 UTF-8
try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:                                             # noqa: BLE001
    pass

HOST = "127.0.0.1"
PORT = 1885                       # Broker 的 TCP 端口（页面上连的是 8085，那是 websocket）
TOPIC_DATA = "Airguard/{zone}/data"
TOPIC_INTERVENTION = "Airguard/intervention/+"
ZONE = "zone-n"                   # 剧本主舞台：宿舍区
ZONE_NAME = {"zone-n": "宿舍区", "zone-s": "教学区", "zone-w": "食堂区"}

# 报文时间从一个固定基准往后排，保证严格递增（乱序判定就是靠它）
BASE = datetime.now() - timedelta(seconds=90)
STEP = 5
_tick = 0


def stamp(offset: int = 0) -> str:
    """生成递增的报文时间戳；offset 为负可造出一条「迟到」的报文"""
    global _tick
    _tick += 1
    return (BASE + timedelta(seconds=STEP * _tick + offset)).strftime("%Y-%m-%d %H:%M:%S")


# ---------------------------------------------------------------- 终端输出
def head(n: int, title: str) -> None:
    print()
    print("=" * 74)
    print(f"  第 {n} 步 · {title}")
    print("=" * 74)


def expect(*lines: str) -> None:
    for i, line in enumerate(lines):
        print(("  预期：" if i == 0 else "        ") + line)


def note(text: str) -> None:
    print("  " + text)


# ---------------------------------------------------------------- MQTT
got_intervention: list = []
lock = threading.Lock()


def on_connect(client, userdata, flags, *args):
    client.subscribe(TOPIC_INTERVENTION, qos=1)
    print(f"  已连接 Broker {HOST}:{PORT}，正在旁听干预广播")
    print()


def on_message(client, userdata, msg):
    with lock:
        got_intervention.append(msg.payload.decode("utf-8", "replace"))
    print(f"\n  ▸ 收到干预广播：{msg.topic}")
    print(f"    {msg.payload.decode('utf-8', 'replace')}\n")


def publish(client, zone: str, pm25, co2, crowd, when: str | None = None, **extra) -> str:
    """发一条监测报文，返回实际发出去的 JSON 文本（重复消息演示要原样重发）"""
    payload = {
        "zoneId": zone,
        "pm25": pm25,
        "co2": co2,
        "crowdLevel": crowd,
        "time": when or stamp(),
    }
    payload.update(extra)
    text = json.dumps(payload, ensure_ascii=False)

    topic = TOPIC_DATA.format(zone=zone)
    client.publish(topic, text, qos=1)
    print(f"  → {topic}")
    print(f"    {text}")
    return text


def resend(client, zone: str, text: str) -> None:
    print(f"  → {TOPIC_DATA.format(zone=zone)}  （原样重发上一条）")
    print(f"    {text}")
    client.publish(TOPIC_DATA.format(zone=zone), text, qos=1)


# ---------------------------------------------------------------- 节奏控制
def _has_key() -> bool:
    """Windows 下探一下有没有按键；非 Windows 直接当没有"""
    try:
        import msvcrt
    except ImportError:
        return False
    return msvcrt.kbhit()


def _read_key() -> None:
    try:
        import msvcrt

        msvcrt.getch()
    except Exception:
        pass


def step_wait(auto: int | None, label: str = "回车继续") -> None:
    if auto is not None:
        time.sleep(auto)
        return
    print(f"  ── {label}（按回车，或直接按 Ctrl+C 退出）── ", end="", flush=True)
    try:
        input()
    except EOFError:
        pass


def wait_intervention(auto: int | None, timeout: int = 300) -> bool:
    """等页面上的干预提交。

    检测到广播就自动继续；超时或者按了回车就跳过。
    这样用户不必盯着终端——在页面上点完，脚本自己就走下去了。
    """
    if auto is not None:
        time.sleep(auto)
        return True

    with lock:
        got_intervention.clear()

    print(f"  ── 等你在宿舍区卡片里勾选干预动作并点【执行干预】（最多 {timeout} 秒）──")
    print("     检测到广播会自动继续；不想等就按回车跳过。")
    deadline = time.time() + timeout
    while time.time() < deadline:
        with lock:
            if got_intervention:
                note("干预广播已收到，继续。")
                return True
        if _has_key():
            _read_key()
            note("已跳过等待。")
            return False
        time.sleep(0.15)
    note("等待超时，先按「没干预」继续往下走。")
    return False


# ---------------------------------------------------------------- 剧本
def main() -> int:
    ap = argparse.ArgumentParser(description="AirGuard D3 事件状态机现场演示")
    ap.add_argument("--auto", type=float, default=None, metavar="N",
                    help="每步之间只停 N 秒，不等回车也不等干预")
    args = ap.parse_args()
    auto = args.auto

    client = _make_client()
    try:
        client.connect(HOST, PORT, keepalive=60)
    except Exception as exc:                                  # noqa: BLE001
        print(f"连不上 Broker {HOST}:{PORT}：{exc}")
        print("先启动 Mosquitto（tcp 1885），再跑本脚本。")
        return 1
    client.loop_start()

    print()
    print("AirGuard D3 演示 —— 三个页面都打开，然后看着它们一起变。")
    if auto is not None:
        print(f"（--auto {auto}：每步只停 {auto} 秒）")

    # ---- 1 基线 --------------------------------------------------------
    head(1, "基线：三个区域全部正常")
    expect("三端全部绿色标牌【正常】，无光晕、无优先标记",
           "人流灯带浅蓝（稀疏）")
    for z in ("zone-n", "zone-s", "zone-w"):
        publish(client, z, 30, 600, 0)
    step_wait(auto)

    # ---- 2 建事件 ------------------------------------------------------
    head(2, "宿舍区出现重度污染 + 严重拥挤 → 建事件 OPEN")
    expect("空气质量标牌变红色，文字带【优先】",
           "宿舍区建筑外圈亮起红色告警光晕",
           "人流灯带变深紫色并脉冲闪烁",
           "告警卡片弹出，红色标题「OPEN 待处理」，内含干预动作多选")
    text_open = publish(client, ZONE, 175, 950, 3)
    step_wait(auto)

    # ---- 3 重复消息 ----------------------------------------------------
    head(3, "同一条报文再发一次 → 只生效一次")
    expect("页面什么都不变（没有第二个事件、没有重复计数）",
           "事件仍是同一个：OPEN，事件开始时间不变")
    resend(client, ZONE, text_open)
    note("去重按 message_id，没有该字段就用 zoneId + time + 载荷哈希；"
         "同一条消息重复到达只生效一次。")
    step_wait(auto)

    # ---- 4 干预 --------------------------------------------------------
    head(4, "在宿舍区卡片里执行干预 → HANDLING")
    expect("四端同时转为「处理中」：卡片黄色标题 HANDLING 处理中",
           "标牌保持红色不变，文字后面多一个【干预执行中】",
           "建筑外圈光晕由红转黄",
           "卡片里列出刚提交的干预动作，并提示不可手动恢复")
    note("这一节必须由你在页面上点——脚本调不动任何状态机。")
    if auto is not None:
        time.sleep(auto)
        _fake_intervention(client, ZONE, ["全开新风+喷雾降尘", "关闭外窗"])
        note("（--auto 模式下由脚本代你广播这条干预，页面上同样会转处理中）")
    else:
        ok = wait_intervention(auto)
        note("已提交。" if ok else "（没等到广播，先按已提交继续）")
    step_wait(auto, "回车发达标数据")

    # ---- 5 第一条达标数据 → 立即恢复 ------------------------------------
    head(5, "干预后第 1 条达标数据 → 立即判定恢复")
    expect("四端同时转为「已恢复」：卡片绿色标题 RECOVERED 已恢复",
           "标牌变回绿色【正常】，【优先】和【干预执行中】后缀都消失",
           "建筑外圈告警光晕删除",
           "卡片显示恢复时间与最终结果「已恢复」，然后自动关闭")
    publish(client, ZONE, 40, 700, 0)
    note("恢复阈值 = 环境正常(good) 且人流稀疏/正常(crowd ≤ 1)。"
         "恢复不设门槛：这一条达标数据到达就判定恢复，不再累计验证次数。")
    note("恢复只能由新监测数据自动判定——点按钮永远不会直接变已恢复。")
    step_wait(auto)

    # ---- 6 迟到消息 ----------------------------------------------------
    head(6, "事件已恢复后，补发一条更早的异常数据 → 状态不回滚")
    expect("状态仍是 RECOVERED，卡片不再弹出",
           "这条只写进历史日志，不参与任何状态判断、也不开新事件")
    publish(client, ZONE, 185, 970, 2, when=stamp(offset=-600))
    note("报文时间早于事件已处理到的最新时刻，就是「迟到消息」："
         "它不能覆盖已经更新的状态。")
    step_wait(auto)

    # ---- 7 干预无效回退 ------------------------------------------------
    head(7, "换个区域演示干预无效 → HANDLING 回退 OPEN")
    expect("教学区先转「处理中」，两组数据都恶化后又变回「OPEN 待处理」",
           "卡片最终结果写着「干预无效，回退待处理」")
    publish(client, "zone-s", 96, 700, 0)          # 轻度污染起手，留出恶化的空间
    step_wait(auto, "回车执行教学区的干预")
    if auto is not None:
        time.sleep(auto)
        _fake_intervention(client, "zone-s", ["开启低档位新风"])
    else:
        wait_intervention(auto, timeout=180)
    publish(client, "zone-s", 175, 950, 1)
    note("第 1 组恶化：仍保持 HANDLING（要连续 2 组才算数）")
    step_wait(auto, "回车发第 2 组恶化数据")
    publish(client, "zone-s", 178, 960, 1)
    note("第 2 组恶化：回退成 OPEN，干预动作选项跟着新的严重度重新给。")
    step_wait(auto)

    print()
    print("=" * 74)
    print("  演示结束。此刻的状态：")
    print("    宿舍区 —— 已恢复，绿色【正常】")
    print("    教学区 —— 待处理 OPEN，红色【优先】+ 红色光晕")
    print("    食堂区 —— 无事件，绿色【正常】")
    print("  三个页面应当完全一致；不一致就是某端的订阅或状态机出了问题。")
    print("=" * 74)
    print()

    client.loop_stop()
    client.disconnect()
    return 0


def _fake_intervention(client, zone: str, actions: list) -> None:
    """--auto 模式下由脚本代你广播干预。

    本端事件号脚本无从得知，这里留空 event_id —— 收端只在 event_id
    存在且与本端对不上时才拒绝，留空等于「不校验」。手动演示时不需要它。"""
    body = json.dumps({"type": "intervention", "event_id": "", "zoneId": zone,
                       "actions": actions, "at": stamp(), "actor": "demo"},
                      ensure_ascii=False)
    client.publish("Airguard/intervention/" + zone, body, qos=1, retain=True)
    print(f"  → Airguard/intervention/{zone}   {body}")


def _make_client() -> mqtt.Client:
    """paho 2.x 要求显式声明回调 API 版本；1.x 没有这个参数"""
    try:
        return mqtt.Client(mqtt.CallbackAPIVersion.VERSION2,
                           client_id=f"airguard-d3-demo-{int(time.time())}")
    except AttributeError:
        return mqtt.Client(client_id=f"airguard-d3-demo-{int(time.time())}")


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\n已中断。")
        sys.exit(130)
