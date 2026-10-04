#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
============================================================================
AirGuard D5 —— 发一条「构造测试样本」报文（规则判正常、ML 判偏离历史）
============================================================================

为什么要造这条报文
------------------
D5 要求：规则与 ML 两种判据并列，不一致时要留下一个「值得分析」的案例。
自然运行里不一定碰得上，所以主动设计一组测试输入：

    · 固定规则：pm25 60（≤ 75）且 co2 700（≤ 1500）→ 判「正常」
    · 轻量 ML ：对比本楼栋历史分布 → 判「与历史明显不同」
                （例如食堂区历史 co2 中位 1242、MAD 105，700 偏低约 3.5σ）

这只是**改测试输入**，模型输出没有被动过手脚：阈值仍是 d5.py 里的常量，
换一份历史数据，这条报文未必还会判成偏离——这正说明判断依据不同。

用法
----
双击同目录下的 D5演示报文.bat（= 本文件，默认发一条并打印预测）
    python d5_publish.py --dry-run        只看预测，不发
    python d5_publish.py --zone zone-n --pm25 60 --co2 700
    python d5_publish.py --all            三个区域各发一条同样的读数

不发的话也可以手动发：把脚本打印的 JSON 原样粘到 MQTTX 的
Airguard/<区域>/data 主题上，效果一样。
============================================================================
"""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:                                             # noqa: BLE001
    pass

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

import d5  # noqa: E402

HOST = "127.0.0.1"
PORT = 1885
TOPIC = "Airguard/{zone}/data"

# 兜底候选：基线算不出合适组合时按这个顺序试（历史数据一变，取值可能要跟着变）
FALLBACK = [
    ("zone-w", 60.0, 550.0),
    ("zone-w", 60.0, 700.0),
    ("zone-s", 60.0, 550.0),
    ("zone-n", 60.0, 550.0),
]


def crafted_candidates(baseline: dict) -> list:
    """照当前历史分布现算几组「规则判正常、ML 判偏离」的读数。

    做法：拿某一个指标的「中位数 − 3.2σ」，同时把另一个指标压到固定规则阈值以内
    （这样规则一定判「正常」），再夹到量程里避免被判成离群。全程只是挑输入，
    模型和阈值一个字都没改。
    """
    out = []
    for zone, _name, _color in d5.ZONES:
        st = (baseline.get("zones") or {}).get(zone) or {}
        co2, pm25 = st.get("co2") or {}, st.get("pm25") or {}
        if co2.get("n", 0) >= d5.ML_MIN_SAMPLES and co2.get("mad"):
            t = co2["median"] - 3.2 * co2["mad"] / 0.6745
            t = round(max(d5.CO2_RANGE[0], min(d5.RULE_CO2_SERIOUS - 50, t)) / 10) * 10
            p = min(pm25.get("median", 40.0), d5.RULE_PM25_WARNING * 0.8)
            out.append((zone, round(p), t))
        if pm25.get("n", 0) >= d5.ML_MIN_SAMPLES and pm25.get("mad"):
            t = pm25["median"] - 3.2 * pm25["mad"] / 0.6745
            t = round(max(d5.PM25_RANGE[0], min(d5.RULE_PM25_WARNING - 5, t)))
            c = min(co2.get("median", 600.0), d5.RULE_CO2_SERIOUS * 0.8)
            out.append((zone, t, round(c)))
    return out


def predict(zone: str, pm25: float, co2: float, baseline: dict) -> dict:
    rule = d5.rule_judge(pm25, co2)
    ml = d5.ml_judge(zone, pm25, co2, baseline)
    ok = rule["label"] == "正常" and ml["label"] == "与历史明显不同"
    return {"zone": zone, "pm25": pm25, "co2": co2, "rule": rule, "ml": ml, "inconsistent": ok}


def show(p: dict) -> None:
    print(f"  区域      : {d5.zone_name(p['zone'])}（{p['zone']}）")
    print(f"  读数      : pm25 {p['pm25']:g} · co2 {p['co2']:g}")
    print(f"  固定规则  : {p['rule']['label']}   （{p['rule']['detail']}）")
    print(f"  轻量 ML   : {p['ml']['label']}   （{p['ml']['detail']}）")
    print(f"  两者一致  : {'否 —— 正是我们要演示的情形' if p['inconsistent'] else '是'}")
    print(f"  裁决      : 规则优先 → 「{p['rule']['label']}」（ML 只作参考，两者同屏可见）")


def publish(zone: str, pm25: float, co2: float, crowd=1, dry: bool = False) -> dict:
    payload = {
        "zoneId": zone,
        "pm25": pm25,
        "co2": co2,
        "crowdLevel": crowd,
        "time": datetime.now().strftime("%Y-%m-%d %H:%M:%S"),
        "note": "D5 构造测试样本（规则与 ML 对照用）",
        # 每条一个唯一 id：四端按 message_id 去重，重复 id 会被当成同一条丢掉
        "message_id": f"d5-demo-{zone}-{uuid.uuid4().hex[:8]}",
    }
    text = json.dumps(payload, ensure_ascii=False)
    if dry:
        print(f"  [--dry-run 未发送] 主题 {TOPIC.format(zone=zone)}")
        print(f"  {text}")
        return payload

    import paho.mqtt.client as mqtt

    if hasattr(mqtt, "CallbackAPIVersion"):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id="airguard-d5-demo")
    else:
        client = mqtt.Client(client_id="airguard-d5-demo")
    client.connect(HOST, PORT, keepalive=15)
    client.loop_start()
    info = client.publish(TOPIC.format(zone=zone), text, qos=1)
    info.wait_for_publish(timeout=5)
    client.loop_stop()
    client.disconnect()
    print(f"  已发布 → {TOPIC.format(zone=zone)}")
    print(f"  {text}")
    return payload


def main() -> None:
    ap = argparse.ArgumentParser(description="D5 构造测试样本：规则判正常、ML 判偏离历史")
    ap.add_argument("--zone", default=None, help="区域编号：zone-n / zone-s / zone-w")
    ap.add_argument("--pm25", type=float, default=None)
    ap.add_argument("--co2", type=float, default=None)
    ap.add_argument("--crowd", type=float, default=1)
    ap.add_argument("--all", action="store_true", help="三个区域各发一条")
    ap.add_argument("--dry-run", action="store_true", help="只打印预测和报文，不发送")
    args = ap.parse_args()

    print("=" * 74)
    print("  AirGuard D5 · 构造测试样本（规则判正常 / ML 判偏离历史）")
    print("=" * 74)

    baseline = d5.load_baseline()
    print(f"  ML 基线：{len(baseline['files'])} 个历史文件 · "
          f"{baseline['rows']} 条去重记录（只读，不会改动任何 CSV）\n")

    if args.zone:
        p = predict(args.zone, args.pm25 if args.pm25 is not None else 60.0,
                    args.co2 if args.co2 is not None else 700.0, baseline)
        show(p)
        print()
        publish(p["zone"], p["pm25"], p["co2"], args.crowd, dry=args.dry_run)
        return

    auto = [predict(*c, baseline) for c in crafted_candidates(baseline)]
    if args.all:
        # 每个区域发一条：优先用现算出来的那组，算不出来就退回兜底候选
        picks = []
        for zone, _name, _color in d5.ZONES:
            hit = next((p for p in auto if p["zone"] == zone and p["inconsistent"]), None)
            if hit is None:
                fb = next((c for c in FALLBACK if c[0] == zone), None)
                hit = predict(*fb, baseline) if fb else None
            if hit:
                picks.append(hit)
    else:
        # 候选排序：偏离度越接近 3σ 越靠前（明显偏离、又不至于离谱），
        # 同样接近时取历史样本多的区域。再挑第一个「规则正常 + ML 偏离」的
        def rank(p):
            zs = [abs(v) for v in p["ml"].get("z", {}).values() if v is not None]
            n = (baseline["zones"].get(p["zone"], {}).get("co2") or {}).get("n", 0)
            return (abs(max(zs) - 3.0) if zs else 99.0, -n)

        auto.sort(key=rank)
        hit = next((p for p in auto if p["inconsistent"]), None)
        if hit is None:
            manual = [predict(*c, baseline) for c in FALLBACK]
            hit = next((p for p in manual if p["inconsistent"]), None)
            if hit is None:
                print("  ⚠ 按当前历史数据，没能凑出「规则正常 + ML 偏离」的组合——")
                print("    历史样本太少或分布已经变了都会这样。下面照实显示实际判定：\n")
                hit = auto[0] if auto else predict(*FALLBACK[0], baseline)
        picks = [hit]

    for p in picks:
        show(p)
        print()
        publish(p["zone"], p["pm25"], p["co2"], args.crowd, dry=args.dry_run)
        print()


if __name__ == "__main__":
    main()
