#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
============================================================================
AirGuard 校园多区域空气质量与人流监测预警协同系统
离线分析链 A —— 历史数据时空统计与趋势分析
============================================================================

用法
----
直接双击本文件即可（或双击同目录下的 运行分析.bat）。
不需要任何命令行参数，不需要在终端敲命令。

    data/history.csv   ──►   report/report.html   ──►  自动用浏览器打开

重新出报告：把新的 history.csv 覆盖到 data/ 目录，再双击一次即可。
报告里的图表、统计数字、复盘文字全部由数据实时算出，无需手工修改。

嫌每次都要重跑太麻烦的话，双击 实时报告.bat（= serve.py）：
它会常驻监视 data/history.csv，文件一变就自动重跑分析，报告页自己刷新，
连浏览器都不用重新打开。本文件里的分析逻辑被它整套复用，两边结果一模一样。

    data/history.csv 一变 ──► serve.py 自动调用 generate_report()
                              ──► report/report.html 更新 ──► 报告页自动刷新

输入
----
data/history.csv   表头字段顺序 time,zone,pm25,co2,crowdLevel,status
                   （用 utf-8-sig 读取，兼容带 BOM 的文件）

输出
----
report/report.html 四个固定板块的网页报告：
                   板块1 历史数据分析 · 板块2 事件时间线
                   板块3 今日摘要     · 板块4 复盘总结
                   所有图表以 base64 内嵌，报告是单个自包含文件，可直接分享

本脚本只做离线分析，不修改 MQTT / Web 大屏 / 3D 沙盘 / 小程序的任何代码。
============================================================================
"""

from __future__ import annotations

import base64
import html
import io
import os
import sys
import traceback
import webbrowser
from datetime import datetime
from pathlib import Path

# ---------------------------------------------------------------------------
# 0. 环境与路径
# ---------------------------------------------------------------------------

# Windows 控制台默认走 GBK 代码页，中文提示在 cmd 里会变乱码。
# 这里把控制台和 Python 的标准输出统一改成 UTF-8（改不动就静默跳过，
# 只是控制台显示问题，不影响报告生成）。
if os.name == "nt":
    try:
        import ctypes

        ctypes.windll.kernel32.SetConsoleOutputCP(65001)
    except Exception:  # noqa: BLE001
        pass
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8", errors="replace")
    except (AttributeError, ValueError, OSError):
        pass

# 路径一律以脚本自身位置为基准解析。
# 双击运行时工作目录通常就是脚本目录，但从 PyCharm 或计划任务启动时
# 工作目录可能是项目根目录——写死相对路径会找不到文件。
BASE_DIR = Path(__file__).resolve().parent
CSV_PATH = BASE_DIR / "data" / "history.csv"
REPORT_DIR = BASE_DIR / "report"
REPORT_PATH = REPORT_DIR / "report.html"

EXPECTED_COLUMNS = ["time", "zone", "pm25", "co2", "crowdLevel", "status"]

# 区域身份色：青绿主色 + 焦橙（预警色）+ 黄绿，整套不含蓝色。
# 分类色按固定顺序绑定区域，不随排名 / 筛选变化。
# 这三个值一起跑过配色校验（对白底 #ffffff）：最差相邻对 deutan ΔE 8.5、
# 正常视觉 ΔE 27.1，亮度区间 / 彩度下限 / 对比度全部达标。
# 注意：报告这套色与 Web 大屏 / 3D 沙盘**不再一致**——那两处用的是含蓝色的
# 旧配色，只服务于深色底；报告是白底，单独定一套。
ZONE_META = {
    "zone-n": ("宿舍区", "#0f9d8f"),   # 青绿（主色）
    "zone-s": ("教学区", "#c2410c"),   # 焦橙（预警色）
    "zone-w": ("食堂区", "#65a30d"),   # 黄绿
}
# CSV 里出现未知区域时的兜底配色（同色系延伸，同样不含蓝色）
FALLBACK_COLORS = ["#0f9d8f", "#c2410c", "#65a30d", "#9d174d"]

# 人流等级是有序的「状态」量：从稀疏到严重拥挤 = 从平静到预警，
# 所以走 青绿 → 琥珀 → 焦橙 的两段色相渐进，而不是单一色相的顺序色阶。
# （四档之间还有图例文字和段内百分比标签兜底，不靠颜色单独表意。）
CROWD_RAMP = ["#b7e4db", "#5cb8a8", "#e08a2e", "#c2410c"]
CROWD_LABELS = ["稀疏", "正常", "拥挤", "严重拥挤"]

SURFACE = "#ffffff"
INK_1 = "#0b0b0b"
INK_2 = "#52514e"
INK_MUTED = "#898781"
# 网格用中性浅灰（原来那版偏蓝），并压到 0.7pt —— 看得见但不抢戏
GRID = "#e8e8e6"
BORDER = "rgba(11,11,11,0.10)"

# 三张图统一的物理宽度和出图倍率。
# 报告页里图片是 width:100%，所以「屏幕上的字号 = 字号pt / 72 × 显示宽 / 图宽」，
# 只跟物理宽度有关。以前三张图宽度分别是 11 / 11.5 / 7.6 英寸，
# 同一页里 9.5pt 的字在 7.6 英寸那张上要大出 50%，看着忽大忽小。
# 统一成同一个 FIG_W 之后，三张图的缩放比完全一致，字号观感就齐了。
FIG_W = 11.0
FIG_DPI = 150        # 页面显示宽 ~1100px，出图 1650px 留出 1.5 倍余量，缩放后更锐利

# 与 Web 大屏 / 3D 沙盘一致的本地预警判定规则
PM25_WARNING, PM25_CRITICAL = 75, 150
CO2_SERIOUS = 1500

# 预警等级由轻到重，用于排序和取「最严重」
LEVEL_ORDER = ["无数据", "正常", "通风不足风险", "轻度污染", "重度污染"]
LEVEL_SEVERITY = {lv: i for i, lv in enumerate(LEVEL_ORDER)}

# ---------------------------------------------------------------------------
# 持续风险与优先关注
# ---------------------------------------------------------------------------
# Web 大屏 / 移动端 / 3D 沙盘与本报告各自实现同一套打分规则，五处必须逐字一致：
#     总分 = 环境异常分 + 人流分
#     人流分 = 人流等级数值本身（稀疏 0 / 正常 1 / 拥挤 2 / 严重拥挤 3）
#     环境分 = 末尾连续异常条数：0 条 → 0 分；1 条 → 1 分；≥2 条 → 3 分
# 报告是离线快照，「末尾」即数据最后一条记录，与实时端的「当前」同口径。
PRIORITY_ENV_SINGLE = 1      # 单次异常
PRIORITY_ENV_STREAK = 3      # 连续多次异常
PRIORITY_SOURCE = "review"   # 感知记录来源，全系统固定；confidence 固定为 null
# 平分时的固定优先顺序，保证同一份数据每次跑出来选中同一个区域
ZONE_ORDER = list(ZONE_META)

# 各等级的处置建议，与 Web / 3D 端保持同一套话术
LEVEL_ACTION = {
    "重度污染": "限制人员停留、暂停室内活动、开启空气净化设备",
    "轻度污染": "减少长时间停留、适时开窗换气",
    "通风不足风险": "立即开窗加强通风、疏散密集人群",
}


def zone_name(zid: str) -> str:
    """区域编号 → 中文名；未知编号原样返回，保证换一份 CSV 也不会崩"""
    return ZONE_META.get(str(zid), (str(zid), None))[0]


def zone_color(zid: str) -> str:
    zid = str(zid)
    if zid in ZONE_META:
        return ZONE_META[zid][1]
    # 未知区域：按编号稳定取色，同一区域每次运行颜色不变
    return FALLBACK_COLORS[sum(map(ord, zid)) % len(FALLBACK_COLORS)]


# 出错后要不要停下来等回车。双击运行时窗口会一闪而过，所以要停；
# 被 serve.py 常驻调用时停住会把服务卡死，靠环境变量在 import 之前就关掉。
INTERACTIVE = os.environ.get("AIRGUARD_NO_PAUSE") != "1"


def die(msg: str, hint: str = "") -> None:
    """致命错误：打印清晰的中文提示后暂停，避免双击运行时窗口一闪而过"""
    print("\n" + "=" * 68)
    print("执行失败：" + msg)
    if hint:
        print("\n" + hint)
    print("=" * 68)
    if INTERACTIVE and sys.stdin and sys.stdin.isatty():
        try:
            input("\n按回车键关闭窗口…")
        except (EOFError, OSError):
            pass
    sys.exit(1)


# ---------------------------------------------------------------------------
# 1. 依赖自检
# ---------------------------------------------------------------------------
# pandas / matplotlib 不是标准库。装着就直接用；没装则给出可照抄的安装命令，
# 而不是抛一串英文 traceback 让人摸不着头脑。

def check_dependencies():
    missing = []
    for mod, pkg in (("pandas", "pandas"), ("matplotlib", "matplotlib"), ("numpy", "numpy")):
        try:
            __import__(mod)
        except ImportError:
            missing.append(pkg)
    if missing:
        py = sys.executable
        die(
            "缺少 Python 依赖库：" + "、".join(missing),
            "请复制下面这行命令，粘贴到「命令提示符」里回车安装：\n\n"
            f'    "{py}" -m pip install ' + " ".join(missing) + "\n\n"
            "如果上面这个 Python 不是你平时用的那个，也可以直接双击\n"
            "同目录下的 运行分析.bat —— 它会自动使用项目自带的虚拟环境。",
        )


check_dependencies()

import matplotlib  # noqa: E402

matplotlib.use("Agg")  # 只输出 PNG，不弹窗；保证无显示器/远程桌面下也能跑
import matplotlib.dates as mdates  # noqa: E402
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402
import pandas as pd  # noqa: E402
from matplotlib.ticker import MaxNLocator  # noqa: E402


# ---------------------------------------------------------------------------
# 2. 中文字体
# ---------------------------------------------------------------------------
# matplotlib 默认字体不含汉字，不设置的话图上所有中文都会变成方框。

def setup_font():
    from matplotlib import font_manager

    candidates = ["Microsoft YaHei", "SimHei", "DengXian", "SimSun", "KaiTi"]
    installed = {f.name for f in font_manager.fontManager.ttflist}
    picked = [name for name in candidates if name in installed]

    matplotlib.rcParams["font.sans-serif"] = picked + ["DejaVu Sans"]
    matplotlib.rcParams["axes.unicode_minus"] = False  # 负号显示为方块的老问题

    if not picked:
        print("  [警告] 系统里没找到常见中文字体，图表中的汉字可能显示为方框。")
    return picked


# ---------------------------------------------------------------------------
# 3. 读取与校验
# ---------------------------------------------------------------------------

def load_csv() -> pd.DataFrame:
    if not CSV_PATH.exists():
        die(
            "找不到数据文件：" + str(CSV_PATH),
            "请确认 data 目录下存在 history.csv。\n"
            "这个文件可以从 Web 监测大屏右上角的「导出 CSV」按钮下载得到。",
        )

    try:
        df = pd.read_csv(CSV_PATH, encoding="utf-8-sig")
    except UnicodeDecodeError:
        # 用户可能手工另存成了 GBK。给出提示而不是直接崩。
        try:
            df = pd.read_csv(CSV_PATH, encoding="gbk")
            print("  [提示] 文件不是 UTF-8 编码，已按 GBK 读取。")
        except Exception as exc:  # noqa: BLE001
            die("CSV 编码无法识别（既不是 UTF-8 也不是 GBK）：" + str(exc))
    except pd.errors.EmptyDataError:
        die("history.csv 是空文件，里面一条记录都没有。")
    except Exception as exc:  # noqa: BLE001
        die("读取 CSV 失败：" + str(exc))

    if df.empty:
        die("history.csv 只有表头、没有数据行，无法生成报告。")

    # 表头严格校验：缺列 / 列名不符都直接说清楚缺了什么
    missing = [c for c in EXPECTED_COLUMNS if c not in df.columns]
    if missing:
        die(
            "CSV 缺少必需的列：" + "、".join(missing),
            "当前表头：" + ",".join(map(str, df.columns)) + "\n"
            "要求表头：" + ",".join(EXPECTED_COLUMNS),
        )

    # 只保留需要的列，顺序也按需求固定下来
    return df[EXPECTED_COLUMNS].copy()


def clean(df: pd.DataFrame) -> tuple[pd.DataFrame, dict]:
    """类型转换 + 派生字段。返回清洗后的数据与一份数据质量台账。"""
    quality = {
        "rows_read": len(df),
        "bad_time": 0,
        "bad_metric": 0,
        "blank_status": 0,
        "status_mismatch": 0,
    }

    df["pm25"] = pd.to_numeric(df["pm25"], errors="coerce")
    df["co2"] = pd.to_numeric(df["co2"], errors="coerce")
    df["crowdLevel"] = pd.to_numeric(df["crowdLevel"], errors="coerce")
    df["zone"] = df["zone"].astype(str).str.strip()
    df["status"] = df["status"].fillna("").astype(str).str.strip()

    # 三个指标全空的记录没有任何分析价值，剔除并计数
    metric_ok = df[["pm25", "co2", "crowdLevel"]].notna().any(axis=1)
    quality["bad_metric"] = int((~metric_ok).sum())
    df = df[metric_ok].copy()

    # 时间解析：兼容 "2026-10-03 16:10:01" 和 "2026-10-3 14:56:00" 这类不补零写法
    try:
        df["ts"] = pd.to_datetime(df["time"], format="mixed", errors="coerce")
    except (ValueError, TypeError):
        df["ts"] = pd.to_datetime(df["time"], errors="coerce")
    quality["bad_time"] = int(df["ts"].isna().sum())

    # 派生：本地重算的预警等级（与 Web / 3D 同一套阈值，不信任上报的 status）
    pm, co2 = df["pm25"], df["co2"]
    df["local_level"] = np.select(
        [pm > PM25_CRITICAL, pm > PM25_WARNING, co2 >= CO2_SERIOUS],
        ["重度污染", "轻度污染", "通风不足风险"],
        default="正常",
    )
    df.loc[pm.isna() & co2.isna(), "local_level"] = "无数据"

    df["zone_name"] = df["zone"].map(zone_name)
    df["crowdLabel"] = df["crowdLevel"].map(
        lambda v: CROWD_LABELS[int(v)] if pd.notna(v) and 0 <= int(v) < len(CROWD_LABELS) else "—"
    )

    quality["blank_status"] = int((df["status"] == "").sum())
    # 上报 status 与本地重算不一致 —— Web 大屏顶栏也在统计这个数
    both = df["status"].ne("") & df["local_level"].ne("无数据")
    quality["status_mismatch"] = int((both & (df["status"] != df["local_level"])).sum())

    df = df.sort_values("ts", kind="stable").reset_index(drop=True)
    return df, quality


# ---------------------------------------------------------------------------
# 4. 统计
# ---------------------------------------------------------------------------

def _ordered(g: pd.DataFrame) -> pd.DataFrame:
    """按时间排好序的区域切片。clean() 已经整体排过一次，但 groupby 之后
    不能再假定顺序，而且 ts 解析失败的行会被排到末尾，得先摘掉。"""
    seq = g.dropna(subset=["ts"]).sort_values("ts", kind="stable")
    return seq if len(seq) else g


def _trailing_abnormal(g: pd.DataFrame) -> tuple:
    """末尾连续异常条数，以及这一轮异常的首条记录时刻。

    只看末尾而不是整段累计，是为了跟实时端的「当前连续异常」对齐：
    中途缓解过又复发，算的是这一轮，不是历史总和。

    返回 (条数, 首条时刻)。条数为 0 或时间戳解析不出来时首条时刻为 None。
    """
    n = 0
    start = None
    for _, row in _ordered(g).iloc[::-1].iterrows():
        if row["local_level"] == "正常":
            break
        start = row["ts"]
        n += 1
    if start is None or pd.isna(start):
        return n, None
    return n, start


def _span_ms(start, end) -> int:
    """本轮连续异常持续时间（毫秒）。两端任一缺失或顺序颠倒都算 0。

    只用报文时间戳相减，不用「现在」——报告端是末尾快照，没有「现在」，
    只有报文时间戳是四端都拿得到的量。
    """
    if start is None or end is None or pd.isna(start) or pd.isna(end):
        return 0
    return max(0, int((end - start).total_seconds() * 1000))


def span_text(ms: int) -> str:
    """时长文案：不足 1 分 → 「N 秒」；不足 1 时 → 「M 分 S 秒」；再长 → 「H 时 M 分」"""
    s = max(0, int((ms or 0) // 1000))
    if s < 60:
        return f"{s} 秒"
    m = s // 60
    if m < 60:
        return f"{m} 分 {s % 60} 秒"
    return f"{m // 60} 时 {m % 60} 分"


def _last_record(g: pd.DataFrame):
    """该区域最后一条记录。数据全无时间戳时退化成最后一行。"""
    seq = _ordered(g)
    return seq.iloc[-1] if len(seq) else None


def priority_scores(zones: list) -> dict:
    """按统一规则给每个区域打分，并选出【当前优先关注】。

    环境分只看末尾那一瞬间：连续异常 0 / 1 / ≥2 条，对应 0 / 1 / 3 分。
    全部区域都是 0 分时 winner 为 None ——「没有需要特别关注的区域」本身
    就是结论，不该硬塞一个 0 分的区域上去凑数。
    """
    rows = []
    for z in zones:
        streak = z["trailing_abnormal"]
        env = 0 if streak == 0 else (PRIORITY_ENV_SINGLE if streak == 1 else PRIORITY_ENV_STREAK)
        raw = z["last_crowd"]
        crowd = max(0, min(len(CROWD_LABELS) - 1, int(raw))) if pd.notna(raw) else 0
        # 持续时间只看本轮连续异常：末条记录时刻 − 首条记录时刻
        span = _span_ms(z.get("trailing_start"), z.get("last_ts"))
        rows.append({
            "zone": z,
            "streak": streak,
            "span": span,
            "span_text": span_text(span),
            "level": z["last_level"],
            "env": env,
            "crowd": crowd,
            "crowd_label": CROWD_LABELS[crowd],
            "total": env + crowd,
        })

    for r in rows:
        r["reason"] = _priority_reason(r)

    # 同分裁决链：总分 → 持续时间 → 环境分 → 人流分 → 固定区域顺序。
    # sorted 是稳定排序，前四级全平时保持 ZONE_ORDER 的先后，结果可复现
    def _rank(r):
        zid = r["zone"]["id"]
        return (r["total"], r["span"], r["env"], r["crowd"],
                -ZONE_ORDER.index(zid) if zid in ZONE_ORDER else -99)

    ranked = sorted(rows, key=_rank, reverse=True)
    top = ranked[0] if ranked else None
    rival = ranked[1] if len(ranked) > 1 else None
    winner = top if top and top["total"] > 0 else None
    if winner:
        winner["verdict"] = _priority_verdict(winner, rival)
    return {"rows": rows, "winner": winner}


def _priority_reason(r: dict) -> str:
    if r["env"] == 0:
        env_txt = "环境正常 0 分"
    elif r["streak"] == 1:
        env_txt = f"环境单次异常（{r['level']}）{PRIORITY_ENV_SINGLE} 分"
    else:
        env_txt = (f"环境连续 {r['streak']} 次异常（{r['level']}）"
                   f"已持续 {span_text(r['span'])} {PRIORITY_ENV_STREAK} 分")
    return f"{env_txt} + 人流{r['crowd_label']} {r['crowd']} 分 → 总分 {r['total']}"


def _priority_verdict(win: dict, rival) -> str:
    """裁决理由：回答「凭什么是它」。rival 是按同一裁决链排出来的第二名。"""
    name = win["zone"]["name"]
    if rival is None or rival["total"] != win["total"]:
        second = f"（次高 {rival['total']} 分）" if rival else ""
        return f"{name}总分 {win['total']} 为三区最高{second}，综合风险最该先处理"

    rival_name = rival["zone"]["name"]
    head = f"与{rival_name}同为 {win['total']} 分"
    if win["span"] != rival["span"]:
        return (f"{head}；{name}环境异常已持续 {span_text(win['span'])}，"
                f"比{rival_name}（{span_text(rival['span'])}）更久，故先处理")
    if win["env"] != rival["env"]:
        return (f"{head}、持续时长相同；{name}环境异常分更高（"
                f"{win['env']} 对 {rival['env']}），故先处理")
    if win["crowd"] != rival["crowd"]:
        return (f"{head}、持续时长与环境分均相同；{name}人流密度等级更高（"
                f"{win['crowd_label']} 对 {rival['crowd_label']}），故先处理")
    return f"{head}且各分项完全相同，按固定区域顺序取{name}"


def perception_rows(zones: list) -> list:
    """每个区域最新的一条感知记录。

    source 与 confidence 在本系统里没有真实来源，写死而不是留空，
    是为了让「这条记录是怎么来的」在报告里一眼可见、不需要额外解释。

    imageId 同样没有真实抓拍图，用「相机 + 区域 + 该区域第几条」拼出来。
    序号而不是时间戳：同一秒内两条报文会撞号，而且用序号才能和实时端
    （那边按会话内的条数递增）对齐。报告取的是末尾那条，序号即该区域的
    记录总数 —— 这是唯一能从 CSV 里确定地推出来的编号。
    """
    out = []
    for z in zones:
        row = z["last_row"]
        ts = row["ts"] if row is not None else None
        raw = row["crowdLevel"] if row is not None else None
        crowd = (CROWD_LABELS[int(raw)]
                 if pd.notna(raw) and 0 <= int(raw) < len(CROWD_LABELS) else "—")
        out.append({
            "zoneId": z["id"],
            "imageId": f"cam-{z['id']}-{z['count']:04d}",
            "crowdLevel": crowd,
            "confidence": "null",
            "source": PRIORITY_SOURCE,
            "time": fmt_time(ts),
        })
    return out


def compute_stats(df: pd.DataFrame) -> dict:
    ts_valid = df["ts"].dropna()
    span = (ts_valid.max() - ts_valid.min()) if len(ts_valid) > 1 else pd.Timedelta(0)

    zones = []
    for zid, g in df.groupby("zone", sort=False):
        trailing_n, trailing_start = _trailing_abnormal(g)
        last = _last_record(g)
        zones.append({
            "id": zid,
            "name": zone_name(zid),
            "color": zone_color(zid),
            "count": int(len(g)),
            "pm25_mean": g["pm25"].mean(),
            "pm25_max": g["pm25"].max(),
            "pm25_min": g["pm25"].min(),
            "co2_mean": g["co2"].mean(),
            "co2_max": g["co2"].max(),
            "co2_min": g["co2"].min(),
            "crowd_mean": g["crowdLevel"].mean(),
            "crowd_max": g["crowdLevel"].max(),
            "crowd_counts": {int(k): int(v) for k, v in g["crowdLevel"].value_counts().items() if pd.notna(k)},
            "abnormal": int((g["local_level"] != "正常").sum()),
            "worst_level": _worst_level(g["local_level"]),
            # 优先关注模块需要的「末尾快照」
            "trailing_abnormal": trailing_n,
            "trailing_start": trailing_start,
            "last_row": last,
            "last_level": last["local_level"] if last is not None else "无数据",
            "last_crowd": last["crowdLevel"] if last is not None else None,
            "last_ts": last["ts"] if last is not None else None,
        })

    abnormal = df[df["local_level"] != "正常"].copy()
    # 板块2 主体：上报 status 异常；补充集：status 正常但本地重算判为风险
    timeline = df[(df["status"] != "") & (df["status"] != "正常")].copy()
    timeline["_kind"] = "上报异常"
    suspect = df[(df["status"] == "正常") & (df["local_level"] != "正常")].copy()
    suspect["_kind"] = "状态存疑"
    all_events = pd.concat([timeline, suspect], ignore_index=True).sort_values("ts", kind="stable")

    # 最需关注的区域：先看周期内出现过的最严重等级，同级别时比异常条数，再比 PM2.5 均值
    focus = None
    if zones:
        focus = max(zones, key=lambda z: (
            LEVEL_SEVERITY.get(z["worst_level"], 0),
            z["abnormal"],
            z["pm25_mean"] if pd.notna(z["pm25_mean"]) else -1,
        ))

    return {
        "ts_min": ts_valid.min() if len(ts_valid) else None,
        "ts_max": ts_valid.max() if len(ts_valid) else None,
        "span": span,
        "zones": zones,
        "abnormal": abnormal,
        "timeline": timeline,
        "suspect": suspect,
        "events": all_events,
        "worst": _worst_level(df["local_level"]),
        "focus": focus,
        "priority": priority_scores(zones),
        "perception": perception_rows(zones),
    }


def _worst_level(series: pd.Series) -> str:
    present = [v for v in LEVEL_ORDER if (series == v).any()]
    return present[-1] if present else "无数据"


# ---------------------------------------------------------------------------
# 5. 图表
# ---------------------------------------------------------------------------
# 三张图都遵循同一条原则：量纲不同的指标不做双 Y 轴，一律拆成并排/堆叠的小图。

def fig_to_base64(fig) -> str:
    buf = io.BytesIO()
    # bbox_inches="tight" 裁掉画布外围的空白；pad_inches 再把它默认留的
    # 0.1 英寸（150dpi 下 15px）压到 0.04，图片四周就不会有一圈厚白边。
    fig.savefig(buf, format="png", dpi=FIG_DPI, bbox_inches="tight",
                pad_inches=0.04, facecolor=SURFACE)
    plt.close(fig)
    return base64.b64encode(buf.getvalue()).decode("ascii")


def style_axes(ax, title: str, ylabel: str = ""):
    ax.set_facecolor(SURFACE)
    ax.set_title(title, fontsize=12.5, color=INK_1, pad=9, loc="left")
    if ylabel:
        ax.set_ylabel(ylabel, fontsize=10.5, color=INK_2, labelpad=6)
    # 只在主刻度上画线，且限制条数——网格是参考线，不是背景纹理
    ax.grid(True, which="major", color=GRID, linewidth=0.7)
    ax.set_axisbelow(True)
    for side in ("top", "right"):
        ax.spines[side].set_visible(False)
    for side in ("left", "bottom"):
        ax.spines[side].set_color(GRID)
        ax.spines[side].set_linewidth(0.8)
    # length=0：去掉短刻度线，靠网格线定位。图更干净，少一半视觉噪音
    ax.tick_params(labelsize=10, colors=INK_MUTED, length=0, pad=5)
    # y 轴最多 5 档。默认的 AutoLocator 在 PM2.5 这种量程上能铺出七八条线，
    # 加上 x 轴的时间刻度就成了一张密网。
    ax.yaxis.set_major_locator(MaxNLocator(nbins=5))


def chart_trend(df: pd.DataFrame, zones: list) -> "str | None":
    """① 时间趋势：pm25 / co2 / crowdLevel 三条时序，三张堆叠小图共用时间轴"""
    sub = df.dropna(subset=["ts"])
    if sub.empty:
        return None

    # 图内文字一律写 "CO2"：下标字符 ₂ (U+2082) 在中文字体里没有字形，
    # 写成 "CO₂" 会在 PNG 上留下一个方框。网页正文不受影响，那里由浏览器做逐字回退。
    metrics = [
        ("pm25", "PM2.5 浓度", "μg/m³", False),
        ("co2", "CO2 浓度", "ppm", False),
        ("crowdLevel", "人流等级", "0–3 档", True),
    ]
    fig, axes = plt.subplots(3, 1, figsize=(FIG_W, 8.8), sharex=True)
    fig.patch.set_facecolor(SURFACE)

    # 时间刻度别铺太密：AutoDateLocator 默认能铺十几条竖线，三张小图叠起来
    # 就是一张密网。7 条够读时间，也留得住留白。每根轴各配一个 locator
    # （共享实例会让 matplotlib 在重绘时互相抢 axis 引用）。
    for ax in axes:
        loc = mdates.AutoDateLocator(maxticks=7)
        ax.xaxis.set_major_locator(loc)
        ax.xaxis.set_major_formatter(mdates.AutoDateFormatter(loc))

    for ax, (col, title, unit, is_step) in zip(axes, metrics):
        plotted = False
        for zi, z in enumerate(zones):
            g = sub[sub["zone"] == z["id"]].dropna(subset=[col])
            if g.empty:
                continue
            ys = g[col]
            if is_step:
                # 人流等级只有 0–3 四档，三个区域经常同时停在同一个档位，
                # 直接画会完全重合、看不出谁是谁。这里给每个区域一个 ±0.07 的
                # 微小错位——远小于一档的间距，读数值仍按最近的整数档位看。
                ys = ys + (zi - (len(zones) - 1) / 2) * 0.14
            # 标记点随采样密度自适应：点少的时候（哪怕只有一两个采样）
            # 必须靠标记才看得见；点一多，几十个白边圆点会把折线打成虚线，
            # 这时候线本身就够了。
            ax.plot(
                g["ts"], ys,
                color=z["color"], linewidth=2,
                marker=None if len(g) > 30 else "o",
                markersize=5.5, markeredgecolor=SURFACE, markeredgewidth=1.4,
                drawstyle="steps-post" if is_step else "default",
                label=z["name"],
            )
            plotted = True
        style_axes(ax, f"{title} 随时间变化", unit)
        if not plotted:
            ax.text(0.5, 0.5, "该指标暂无有效数据", ha="center", va="center",
                    transform=ax.transAxes, color=INK_MUTED, fontsize=11.5)
        if is_step:
            ax.set_yticks(range(0, 4))
            ax.set_yticklabels([f"{n} · {CROWD_LABELS[n]}" for n in range(4)])
            # set_yticks 会重建刻度对象，样式得再刷一遍，否则这三行会掉回默认的黑字
            ax.tick_params(axis="y", labelsize=10, colors=INK_MUTED, length=0, pad=5)
            ax.set_ylim(-0.35, 3.35)
        else:
            # 顶部留出一截空白：图例放在左上角，不留余量的话
            # 某条曲线冲到高点时会顶到图例上
            lo, hi = ax.get_ylim()
            ax.set_ylim(lo, hi + (hi - lo) * 0.18)

    # 只有一个采样时刻时，matplotlib 会按默认规则铺开一个毫无意义的宽量程
    # （实测能拉到前后好几年）。这里按实际数据跨度手动收窄并留边。
    t_min, t_max = sub["ts"].min(), sub["ts"].max()
    pad = pd.Timedelta(minutes=30) if t_max == t_min else (t_max - t_min) * 0.04
    for ax in axes:
        ax.set_xlim(t_min - pad, t_max + pad)

    axes[0].legend(loc="upper left", frameon=False, fontsize=10,
                   ncol=len(zones), handlelength=1.6, columnspacing=1.6)
    axes[-1].set_xlabel("采样时间", fontsize=10.5, color=INK_2, labelpad=6)
    fig.autofmt_xdate(rotation=0, ha="center")
    fig.suptitle("图 1 · 三区域指标时序趋势", fontsize=14, color=INK_1,
                 x=0.005, ha="left", y=0.996)
    # h_pad 收紧（默认 1.08 个字号）：三张小图各自带标题，
    # 中间不需要再留一条宽缝
    fig.tight_layout(rect=(0, 0, 1, 0.972), h_pad=0.9)
    return fig_to_base64(fig)


def chart_zone_compare(zones: list) -> "str | None":
    """② 空间统计：按 zone 分组，对三个区域做同指标横向对比"""
    if not zones:
        return None

    names = [z["name"] for z in zones]
    colors = [z["color"] for z in zones]
    panels = [
        ("PM2.5 均值", "μg/m³", [z["pm25_mean"] for z in zones]),
        ("CO2 均值", "ppm", [z["co2_mean"] for z in zones]),
        ("人流等级均值", "0–3 档", [z["crowd_mean"] for z in zones]),
    ]
    fig, axes = plt.subplots(1, 3, figsize=(FIG_W, 4.3))
    fig.patch.set_facecolor(SURFACE)

    for ax, (title, unit, vals) in zip(axes, panels):
        ypos = np.arange(len(names))
        draw = [0 if (v is None or pd.isna(v)) else v for v in vals]
        # 全部为 0 或全缺失时给个非零量程，否则坐标轴会退化成一条线
        span = max(draw) if draw else 1
        span = span or 1

        ax.barh(ypos, draw, color=colors, height=0.52)
        ax.set_yticks(ypos)
        ax.set_yticklabels(names)
        # 固定纵向量程（而不是 invert_yaxis + 自动缩放），这样区域只有一两个时
        # 柱子不会撑满整个画布，多区域和单区域的观感保持一致
        ax.set_ylim(len(names) - 0.6, -0.6)
        style_axes(ax, title, unit)
        # style_axes 会把所有刻度统一刷成浅灰小字；区域名是要读的，
        # 单独再刷回正文色和正常字号（放在 style_axes 之后才不会被覆盖）
        ax.tick_params(axis="y", labelsize=10.5, colors=INK_2, length=0, pad=6)
        # 数值直接标在柱子末端：既是可读性补偿，也让区域对比不必只靠颜色
        for y, v in zip(ypos, vals):
            txt = "—" if (v is None or pd.isna(v)) else f"{v:.1f}"
            ax.text((0 if pd.isna(v) else v) + span * 0.028, y, txt,
                    va="center", ha="left", fontsize=10.5, color=INK_1)
        # 右端留出余量：数值标签贴在柱末端，量程刚好卡到最大值时标签会被裁掉
        ax.set_xlim(0, span * 1.26)
        ax.grid(axis="y", visible=False)   # 横向条形图只需竖向参考线

    fig.suptitle("图 2 · 三区域指标横向对比", fontsize=14, color=INK_1,
                 x=0.005, ha="left", y=0.985)
    fig.tight_layout(rect=(0, 0, 1, 0.93), w_pad=2.4)
    return fig_to_base64(fig)


def chart_crowd_mix(zones: list) -> "str | None":
    """③ 人流等级构成：每个区域在各档位停留的报文占比"""
    usable = [z for z in zones if sum(z["crowd_counts"].values()) > 0]
    if not usable:
        return None

    names = [z["name"] for z in usable]
    xs = np.arange(len(usable))
    # 宽度和另外两张图对齐（见 FIG_W 的说明）：以前这张是 7.6 英寸，
    # 同样的 100% 缩放把它放大了 1.5 倍，字看着比图 1 大一圈
    fig, ax = plt.subplots(figsize=(FIG_W, 3.6))
    fig.patch.set_facecolor(SURFACE)

    bottom = np.zeros(len(usable))
    for lvl in range(len(CROWD_LABELS)):
        vals = np.array([
            z["crowd_counts"].get(lvl, 0) / sum(z["crowd_counts"].values()) * 100 for z in usable
        ])
        # 固定柱宽而不是按分类自适应：只有一个区域时柱子不会撑满整个画布
        ax.bar(xs, vals, width=0.62, bottom=bottom, color=CROWD_RAMP[lvl],
               label=f"{lvl} · {CROWD_LABELS[lvl]}",
               edgecolor=SURFACE, linewidth=2.0)  # 段间留白，避免相邻色块糊成一片
        for x, (v, b) in enumerate(zip(vals, bottom)):
            if v >= 8:  # 太窄的段不标，避免文字压线
                # 最深的一档是焦橙底，配白字；其余几档底色浅，配深墨色
                ax.text(x, b + v / 2, f"{v:.0f}%", ha="center", va="center",
                        fontsize=10.5, color=SURFACE if lvl >= 3 else INK_1)
        bottom += vals

    style_axes(ax, "按报文条数占比", "占比 %")
    ax.set_ylim(0, 100)
    ax.set_xticks(xs)
    ax.set_xticklabels(names)
    ax.tick_params(axis="x", labelsize=11, colors=INK_2)   # 区域名要读，刷回正文色
    ax.set_xlim(-0.62, len(usable) - 0.38)
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.13), ncol=4,
              frameon=False, fontsize=10.5, columnspacing=2.0, handlelength=1.4)
    fig.suptitle("图 3 · 各区域人流等级构成", fontsize=14, color=INK_1,
                 x=0.005, ha="left", y=0.985)
    fig.tight_layout(rect=(0, 0, 1, 0.93))
    return fig_to_base64(fig)


# ---------------------------------------------------------------------------
# 6. HTML 片段
# ---------------------------------------------------------------------------

def esc(v) -> str:
    return html.escape("—" if v is None or (isinstance(v, float) and pd.isna(v)) else str(v))


def fmt(v, digits=1, suffix="") -> str:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return "—"
    return f"{v:.{digits}f}{suffix}"


def fmt_time(t) -> str:
    return "—" if t is None or pd.isna(t) else pd.Timestamp(t).strftime("%Y-%m-%d %H:%M:%S")


def fmt_span(td) -> str:
    total = int(td.total_seconds()) if td is not None and not pd.isna(td) else 0
    if total <= 0:
        return "单点采集（不足 1 分钟）"
    h, m = divmod(total // 60, 60)
    if h:
        return f"{h} 小时 {m} 分钟"
    return f"{m} 分钟"


def level_class(level: str) -> str:
    return {"正常": "ok", "通风不足风险": "warn", "轻度污染": "warn",
            "重度污染": "bad", "无数据": "muted"}.get(level, "muted")


def build_zone_table(zones: list) -> str:
    rows = []
    for z in zones:
        rows.append(f"""      <tr>
        <th scope="row"><span class="dot" style="background:{z['color']}"></span>{esc(z['name'])}</th>
        <td>{z['count']}</td>
        <td>{fmt(z['pm25_mean'])} / <b>{fmt(z['pm25_max'])}</b></td>
        <td>{fmt(z['co2_mean'], 0)} / <b>{fmt(z['co2_max'], 0)}</b></td>
        <td>{fmt(z['crowd_mean'], 2)} / <b>{esc(int(z['crowd_max']) if pd.notna(z['crowd_max']) else '—')}</b></td>
        <td>{z['abnormal']}</td>
        <td><span class="tag {level_class(z['worst_level'])}">{esc(z['worst_level'])}</span></td>
      </tr>""")
    return "\n".join(rows)


def build_timeline(events: pd.DataFrame, suspect_count: int) -> str:
    if events.empty:
        return ('      <p class="empty">本次采集周期内没有 status 异常的记录，'
                '所有区域的上报状态均为「正常」。</p>')

    items = []
    for _, r in events.iterrows():
        kind = r["_kind"]
        badge = "上报异常" if kind == "上报异常" else "状态存疑"
        cls = "bad" if kind == "上报异常" else "warn"
        note = ("" if kind == "上报异常" else
                "（上报 status 为「正常」，但按阈值本地重算判定为风险，建议复核传感器）")
        items.append(f"""      <li class="tl-item {cls}">
        <div class="tl-time">{esc(fmt_time(r['ts']))}</div>
        <div class="tl-body">
          <div class="tl-head">
            <span class="dot" style="background:{zone_color(r['zone'])}"></span>
            <b>{esc(zone_name(r['zone']))}</b>
            <span class="tag {cls}">{badge}</span>
            <span class="tag {level_class(r['local_level'])}">{esc(r['local_level'])}</span>
          </div>
          <div class="tl-meta">
            上报状态：<b>{esc(r['status'] if r['status'] else '未上报')}</b>
            ｜ PM2.5 {esc(r['pm25'] if pd.notna(r['pm25']) else '—')} μg/m³
            ｜ CO₂ {esc(r['co2'] if pd.notna(r['co2']) else '—')} ppm
            ｜ 人流 {esc(r['crowdLabel'])}{note and ' ' + note}
          </div>
        </div>
      </li>""")

    extra = (f'      <p class="note">其中 {suspect_count} 条属于「状态存疑」：'
             f'上报 status 为正常、但本地重算判定为风险，已在上面用橙色标出。</p>'
             if suspect_count else "")
    return '      <ol class="timeline">\n' + "\n".join(items) + "\n      </ol>\n" + extra


# ---------------------------------------------------------------------------
# 7. 板块4：复盘总结（全部文字由数据推导，换 CSV 后自动改写）
# ---------------------------------------------------------------------------

def build_review(df: pd.DataFrame, stats: dict, quality: dict) -> str:
    zones = stats["zones"]
    paras = []

    # --- 采集概况 ---
    span_txt = fmt_span(stats["span"])
    zone_txt = "、".join(z["name"] for z in zones)
    multi = "各区域均有数据" if len(zones) > 1 else "只有一个区域上报了数据"
    paras.append(
        f"本次分析覆盖 <b>{len(df)}</b> 条有效记录，时间跨度 {span_txt}，"
        f"涉及 {len(zones)} 个区域（{esc(zone_txt)}）。{multi}。"
    )

    # --- 空气质量复盘 ---
    pm_zones = [z for z in zones if pd.notna(z["pm25_mean"])]
    if len(pm_zones) == 1:
        # 只有一个区域有数据时，「最高」和「最低」是同一个区域，
        # 套用对比句式会读成自相矛盾，所以单独措辞
        z0 = pm_zones[0]
        seg = (f"PM2.5 方面，本次只有 <b>{esc(z0['name'])}</b> 一个区域有数据，"
               f"周期均值 {fmt(z0['pm25_mean'])} μg/m³")
        if pd.notna(z0["pm25_max"]) and z0["pm25_max"] > PM25_WARNING:
            seg += f"，峰值 {fmt(z0['pm25_max'])} μg/m³，已越过轻度污染线（{PM25_WARNING}）"
        paras.append(seg + "。")
    elif pm_zones:
        worst_pm = max(pm_zones, key=lambda z: z["pm25_mean"])
        best_pm = min(pm_zones, key=lambda z: z["pm25_mean"])
        seg = (f"PM2.5 方面，<b>{esc(worst_pm['name'])}</b> 周期均值最高，达到 "
               f"{fmt(worst_pm['pm25_mean'])} μg/m³")
        if worst_pm["pm25_max"] is not None and pd.notna(worst_pm["pm25_max"]) \
                and worst_pm["pm25_max"] > PM25_WARNING:
            seg += f"，峰值 {fmt(worst_pm['pm25_max'])} μg/m³，已越过轻度污染线（{PM25_WARNING}）"
        seg += (f"；<b>{esc(best_pm['name'])}</b> 最低，均值 {fmt(best_pm['pm25_mean'])} μg/m³。")
        if len(pm_zones) > 1:
            gap = worst_pm["pm25_mean"] - best_pm["pm25_mean"]
            seg += f"两者相差 {fmt(gap)} μg/m³，区域间空气质量差异" + \
                   ("较明显。" if gap > 20 else "不大。")
        paras.append(seg)

    co2_zones = [z for z in zones if pd.notna(z["co2_mean"])]
    if co2_zones:
        worst_co2 = max(co2_zones, key=lambda z: z["co2_mean"])
        seg = (f"CO₂ 方面，<b>{esc(worst_co2['name'])}</b> 周期均值"
               + ("最高" if len(co2_zones) > 1 else "")
               + f"（{fmt(worst_co2['co2_mean'], 0)} ppm）")
        if pd.notna(worst_co2["co2_max"]) and worst_co2["co2_max"] >= CO2_SERIOUS:
            seg += (f"，峰值 {fmt(worst_co2['co2_max'], 0)} ppm，达到通风不足风险阈值"
                    f"（{CO2_SERIOUS} ppm），说明该区域在高峰时段换气能力不足")
        else:
            seg += "，全程未触及通风不足风险阈值"
        seg += "。"
        paras.append(seg)

    # --- 人流复盘 ---
    crowd_zones = [z for z in zones if pd.notna(z["crowd_mean"])]
    if crowd_zones:
        busiest = max(crowd_zones, key=lambda z: z["crowd_mean"])
        seg = (f"人流方面，<b>{esc(busiest['name'])}</b> 的平均等级"
               + ("最高" if len(crowd_zones) > 1 else "")
               + f"为 {fmt(busiest['crowd_mean'], 2)}，峰值 "
               f"{esc(int(busiest['crowd_max']) if pd.notna(busiest['crowd_max']) else '—')} 档")
        heavy = busiest["crowd_counts"].get(2, 0) + busiest["crowd_counts"].get(3, 0)
        if heavy:
            seg += f"，其中 {heavy} 条报文处于拥挤及以上档位"
            # 只有一个区域时谈不上「全场主要来源」，这个说法只在多区域对比时成立
            seg += "，是全场人流压力的主要来源" if len(crowd_zones) > 1 else "，需重点疏导"
        seg += "。"
        paras.append(seg)

    # --- 异常事件复盘 ---
    n_abn = len(stats["abnormal"])
    tl = stats["timeline"]
    if n_abn == 0:
        paras.append("异常情况：本次采集周期内所有记录均判定为「正常」，未出现需要处置的风险事件。")
    else:
        by_zone = stats["abnormal"]["zone_name"].value_counts()
        top_zone = by_zone.index[0]
        by_level = stats["abnormal"]["local_level"].value_counts()
        seg = (f"异常情况：共 <b>{n_abn}</b> 条记录被判定为风险，占全部记录的 "
               f"{n_abn / len(df) * 100:.1f}%，集中在 <b>{esc(top_zone)}</b>"
               f"（{int(by_zone.iloc[0])} 条）；类型以「{esc(by_level.index[0])}」为主。")
        if stats["ts_min"] is not None and len(tl):
            seg += f" 最早的异常出现在 {fmt_time(tl['ts'].min())}。"
        paras.append(seg)

        # 风险结论 → 处置建议，与 Web/3D 端保持同一套话术
        tips = []
        for lvl in by_level.index:
            if lvl in LEVEL_ACTION:
                tips.append(f"「{lvl}」→ {LEVEL_ACTION[lvl]}")
        if tips:
            paras.append("处置建议：" + "；".join(tips) + "。")

    # --- 数据质量 ---
    q = []
    if quality["bad_metric"]:
        q.append(f"{quality['bad_metric']} 条记录的三个指标全部为空，已剔除")
    if quality["bad_time"]:
        q.append(f"{quality['bad_time']} 条记录的时间无法解析，未参与时序分析")
    if quality["blank_status"]:
        q.append(f"{quality['blank_status']} 条记录没有上报 status")
    if quality["status_mismatch"]:
        q.append(f"<b>{quality['status_mismatch']}</b> 条记录的上报 status 与本地重算结果不一致"
                 f"（已按阈值以本地重算为准，与 Web 大屏口径一致）")
    paras.append("数据质量：" + ("；".join(q) + "。" if q else "字段完整，未发现缺失或冲突。"))

    return "\n      ".join(f"<p>{p}</p>" for p in paras)


# ---------------------------------------------------------------------------
# 8. 报告 HTML
# ---------------------------------------------------------------------------

CSS = """
* { box-sizing: border-box; }
body {
  margin: 0; padding: 32px 20px 64px;
  background: #f2f4f3; color: #0b0b0b;
  font: 14px/1.7 "Microsoft YaHei", "PingFang SC", "Segoe UI", sans-serif;
}
.wrap { max-width: 1160px; margin: 0 auto; }
header.page {
  background: #fff; border: 1px solid rgba(11,11,11,.10); border-radius: 14px;
  padding: 22px 26px; margin-bottom: 20px;
  display: flex; flex-wrap: wrap; gap: 8px 24px; align-items: baseline;
}
header.page h1 { margin: 0; font-size: 20px; letter-spacing: .3px; }
header.page .sub { color: #898781; font-size: 12.5px; }
section.card {
  background: #fff; border: 1px solid rgba(11,11,11,.10); border-radius: 14px;
  padding: 22px 26px 26px; margin-bottom: 20px;
}
section.card > h2 {
  margin: 0 0 4px; font-size: 16px; display: flex; align-items: center; gap: 10px;
}
section.card > h2 .num {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 7px;
  background: #0f9d8f; color: #fff; font-size: 12px;
}
section.card > .lead { margin: 0 0 18px; color: #898781; font-size: 12.5px; }
figure { margin: 0 0 8px; }
figure img { width: 100%; height: auto; display: block; border-radius: 8px; }
figcaption { color: #898781; font-size: 12px; margin-top: 6px; }
table { width: 100%; border-collapse: collapse; margin-top: 14px; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid #ebedec; }
thead th { color: #898781; font-weight: 600; font-size: 12px; white-space: nowrap; }
tbody th { font-weight: 600; white-space: nowrap; }
tbody tr:last-child th, tbody tr:last-child td { border-bottom: 0; }
.dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 7px; }
.tag {
  display: inline-block; padding: 1px 8px; border-radius: 999px;
  font-size: 11.5px; font-weight: 600; border: 1px solid transparent;
}
.tag.ok    { background: #e6f5ea; color: #0b6b36; border-color: #bfe3cb; }
.tag.warn  { background: #fdf3dd; color: #8a5f00; border-color: #f0dcae; }
.tag.bad   { background: #fdeaea; color: #8e1a1a; border-color: #f3c9c9; }
.tag.muted { background: #f2f4f3; color: #5b6675; border-color: #e2e5e3; }
.kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 12px; margin-bottom: 4px; }
.kpi { background: #f7f9f8; border: 1px solid rgba(11,11,11,.07); border-radius: 10px; padding: 13px 15px; }
.kpi .k { color: #898781; font-size: 12px; }
.kpi .v { font-size: 21px; font-weight: 600; margin-top: 3px; font-variant-numeric: tabular-nums; }
.kpi .v small { font-size: 12px; font-weight: 400; color: #898781; margin-left: 3px; }
.timeline { list-style: none; margin: 6px 0 0; padding: 0; }
.tl-item { display: flex; gap: 16px; padding: 13px 0 13px 15px; border-left: 2px solid #e8ecf2; }
.tl-item.bad { border-left-color: #d03b3b; }
.tl-item.warn { border-left-color: #fab219; }
.tl-time { flex: 0 0 152px; color: #52514e; font-variant-numeric: tabular-nums; font-size: 12.5px; }
.tl-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tl-meta { color: #52514e; font-size: 12.5px; margin-top: 3px; }
.note, .empty { color: #898781; font-size: 12.5px; margin: 14px 0 0; }
.empty { padding: 18px; background: #f7f9fc; border-radius: 10px; text-align: center; }
.review p { margin: 0 0 12px; }
h3.sub-head { margin: 26px 0 0; font-size: 14px; }
.sub-head + .lead { margin: 4px 0 14px; }
.score-table tbody tr.win { background: #fdf6ee; }
.score-table tbody tr.win th[scope="row"] { box-shadow: inset 3px 0 0 #c2410c; }
.score-table .reason { color: #52514e; font-size: 12.5px; }
.verdict { margin: 12px 0 0; color: #52514e; font-size: 13px; line-height: 1.6; }
.verdict b { color: #c2410c; }
.score-table small { color: #898781; }
.perception-table code {
  background: #f2f4f3; padding: 1px 6px; border-radius: 5px;
  font-size: 12px; font-family: Consolas, "Courier New", monospace;
}
.perception-table .muted-cell { color: #898781; }
footer.page { color: #898781; font-size: 12px; text-align: center; padding-top: 6px; }
"""


def build_priority(priority: dict) -> str:
    """板块5 主体：三区域得分表 + 最近感知记录表。"""
    rows, winner = priority["rows"], priority["winner"]
    win_id = winner["zone"]["id"] if winner else None

    score_rows = []
    for r in rows:
        z = r["zone"]
        mark = ' <span class="tag bad">当前优先关注</span>' if z["id"] == win_id else ""
        score_rows.append(
            f"""      <tr class="{'win' if z['id'] == win_id else ''}">
        <th scope="row"><span class="dot" style="background:{z['color']}"></span>{esc(z['name'])}{mark}</th>
        <td>{r['env']}</td>
        <td>{r['crowd']} <small>{esc(r['crowd_label'])}</small></td>
        <td><strong>{r['total']}</strong></td>
        <td class="reason">{esc(r['reason'])}</td>
      </tr>""")

    return f"""    <table class="score-table">
      <thead><tr>
        <th scope="col">区域</th><th scope="col">环境异常分</th><th scope="col">人流分</th>
        <th scope="col">总分</th><th scope="col">判断理由</th>
      </tr></thead>
      <tbody>
{chr(10).join(score_rows)}
      </tbody>
    </table>"""


def build_perception(rows: list) -> str:
    """板块5 附：最近感知记录明细。"""
    body = []
    for r in rows:
        body.append(
            f"""      <tr>
        <td><code>{esc(r['zoneId'])}</code></td>
        <td><code>{esc(r['imageId'])}</code></td>
        <td>{esc(r['crowdLevel'])}</td>
        <td class="muted-cell">{esc(r['confidence'])}</td>
        <td><code>{esc(r['source'])}</code></td>
        <td>{esc(r['time'])}</td>
      </tr>""")
    return f"""    <table class="perception-table">
      <thead><tr>
        <th scope="col">zoneId</th><th scope="col">imageId</th><th scope="col">crowdLevel</th>
        <th scope="col">confidence</th><th scope="col">source</th><th scope="col">time</th>
      </tr></thead>
      <tbody>
{chr(10).join(body)}
      </tbody>
    </table>"""


def build_html(df, stats, quality, charts, generated_at) -> str:
    zones = stats["zones"]
    n_abn = len(stats["abnormal"])
    focus = stats["focus"]

    def kpi_tiles(items) -> str:
        """items: (标签, 主值HTML, 后缀HTML)。主值允许带标记，所以不做转义。"""
        return "\n        ".join(
            f'<div class="kpi"><div class="k">{esc(k)}</div>'
            f'<div class="v">{v}<small>{s}</small></div></div>'
            for k, v, s in items
        )

    # 板块1 的卡片回答「数据覆盖了什么」，板块3 的卡片回答「风险状况如何」，
    # 两组刻意不重合，避免同一批数字在报告里出现两遍。
    kpi_data = kpi_tiles([
        ("有效记录", f"{len(df)}", "条"),
        ("覆盖区域", f"{len(zones)}", "个"),
        ("采样时间跨度", fmt_span(stats["span"]), ""),
        ("读入 / 有效", f"{quality['rows_read']}", f"行 · 剔除 {quality['rows_read'] - len(df)} 行"),
    ])
    kpi_risk = kpi_tiles([
        ("风险记录", f"{n_abn}", f"条 · 占 {n_abn / len(df) * 100:.1f}%"),
        ("全周期最严重等级",
         f'<span class="tag {level_class(stats["worst"])}">{esc(stats["worst"])}</span>', ""),
        ("最需关注区域",
         esc(focus["name"]) if focus else "—",
         f'（{esc(focus["worst_level"])}）' if focus else ""),
        ("上报与重算不一致", f"{quality['status_mismatch']}", "条"),
    ])

    # 板块5 的结论卡：一眼看到「关注谁、多少分、为什么」
    pri = stats["priority"]
    win = pri["winner"]
    if win:
        kpi_priority = kpi_tiles([
            ("当前优先关注",
             f'<span class="dot" style="background:{win["zone"]["color"]}"></span>{esc(win["zone"]["name"])}', ""),
            ("总分", f"{win['total']}", f"= 环境 {win['env']} + 人流 {win['crowd']}"),
            ("末尾连续异常", f"{win['streak']}", f"次 · {esc(win['level'])}"),
            ("异常已持续", esc(win["span_text"]), "末条 − 首条记录时刻"),
        ])
        # 裁决理由单独一行：它回答的是「凭什么是它」，与上面的分项构成不是一回事
        kpi_priority += (f'\n        <p class="verdict"><b>裁决</b> · {esc(win["verdict"])}</p>')
    else:
        kpi_priority = kpi_tiles([
            ("当前优先关注", "暂无", "各区域均为 0 分"),
            ("总分", "0", "环境正常 · 人流稀疏"),
        ])

    figures = []
    if charts["trend"]:
        figures.append('<figure><img alt="三区域指标时序趋势" src="data:image/png;base64,'
                       + charts["trend"] + '"><figcaption>图 1 · PM2.5 / CO₂ / 人流等级随时间的'
                       '变化。三个指标量纲不同，拆成三张共享时间轴的子图，避免双 Y 轴造成的误读。'
                       '</figcaption></figure>')
    if charts["zoom"]:
        figures.append('<figure><img alt="三区域指标横向对比" src="data:image/png;base64,'
                       + charts["zoom"] + '"><figcaption>图 2 · 按区域分组的指标均值对比，'
                       '柱端直接标注数值。</figcaption></figure>')
    if charts["crowd"]:
        figures.append('<figure><img alt="各区域人流等级构成" src="data:image/png;base64,'
                       + charts["crowd"] + '"><figcaption>图 3 · 各区域人流等级构成。人流等级是'
                       '有序量，配色从青绿到焦橙逐级过渡：平静档用青绿，拥挤档转暖色预警，'
                       '而不是套一组彼此无关的分类色。</figcaption></figure>')

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AirGuard 历史数据分析报告</title>
<style>{CSS}</style>
</head>
<body>
<div class="wrap">

  <header class="page">
    <h1>AirGuard 历史数据分析报告</h1>
    <span class="sub">校园多区域空气质量与人流监测预警协同系统 · 离线分析链 A</span>
    <span class="sub">数据源：{esc(CSV_PATH.name)}（{len(df)} 条有效记录）</span>
    <span class="sub">生成时间：{esc(generated_at)}</span>
  </header>

  <section class="card" id="sec1">
    <h2><span class="num">1</span>历史数据分析</h2>
    <p class="lead">采集时段 {esc(fmt_time(stats['ts_min']))} 至 {esc(fmt_time(stats['ts_max']))}，
       共 {esc(fmt_span(stats['span']))}。下面依次是数据概况、指标时序趋势、区域横向对比。</p>
    <div class="kpis">
        {kpi_data}
    </div>
    {"".join(figures)}
    <table>
      <caption class="lead" style="text-align:left;margin:16px 0 0">各区域统计明细（均值 / 峰值）</caption>
      <thead>
        <tr>
          <th scope="col">区域</th><th scope="col">记录数</th>
          <th scope="col">PM2.5 μg/m³</th><th scope="col">CO₂ ppm</th>
          <th scope="col">人流等级</th><th scope="col">异常条数</th><th scope="col">最严重等级</th>
        </tr>
      </thead>
      <tbody>
{build_zone_table(zones)}
      </tbody>
    </table>
  </section>

  <section class="card" id="sec2">
    <h2><span class="num">2</span>事件时间线</h2>
    <p class="lead">筛选 status 异常的记录，按时间先后顺序排列，共 {len(stats['timeline'])} 条；
       另有 {len(stats['suspect'])} 条上报正常但本地重算存疑，一并列出以便复核。</p>
{build_timeline(stats['events'], len(stats['suspect']))}
  </section>

  <section class="card" id="sec3">
    <h2><span class="num">3</span>今日摘要</h2>
    <p class="lead">本次采集周期内的整体概况：先看风险面，再看逐项汇总。</p>
    <div class="kpis">
        {kpi_risk}
    </div>
    <table>
      <thead><tr><th scope="col">摘要项</th><th scope="col">数值</th></tr></thead>
      <tbody>
        <tr><th scope="row">采集起止</th><td>{esc(fmt_time(stats['ts_min']))} — {esc(fmt_time(stats['ts_max']))}</td></tr>
        <tr><th scope="row">时间跨度</th><td>{esc(fmt_span(stats['span']))}</td></tr>
        <tr><th scope="row">有效记录 / 读入记录</th><td>{len(df)} / {quality['rows_read']}</td></tr>
        <tr><th scope="row">参与统计的区域</th><td>{esc('、'.join(z['name'] for z in zones))}</td></tr>
        <tr><th scope="row">本地重算判定为风险的记录</th><td>{n_abn} 条（占 {n_abn / len(df) * 100:.1f}%）</td></tr>
        <tr><th scope="row">上报 status 非正常的记录</th><td>{len(stats['timeline'])} 条</td></tr>
        <tr><th scope="row">上报与重算不一致</th><td>{quality['status_mismatch']} 条</td></tr>
        <tr><th scope="row">全周期最严重等级</th><td><span class="tag {level_class(stats['worst'])}">{esc(stats['worst'])}</span></td></tr>
      </tbody>
    </table>
  </section>

  <section class="card" id="sec4">
    <h2><span class="num">4</span>复盘总结</h2>
    <p class="lead">针对本次采集的数据与异常事件给出的文字复盘，全部结论由数据实时推导。</p>
    <div class="review">
      {build_review(df, stats, quality)}
    </div>
  </section>

  <section class="card" id="sec5">
    <h2><span class="num">5</span>持续风险与优先关注</h2>
    <p class="lead">按「环境异常分 + 人流分」给每个区域打分，总分最高者为当前优先关注。
       环境异常分看的是<b>数据末尾</b>这一瞬间的连续异常条数（0 条 0 分 / 1 条 1 分 / 连续多次 3 分），
       人流分即人流等级本身（稀疏 0 / 正常 1 / 拥挤 2 / 严重拥挤 3）。
       总分相同时依次比<b>本轮异常持续时间</b>（末条记录时刻 − 首条记录时刻）、环境异常分、人流分，
       仍相同则按固定区域顺序（宿舍区 → 教学区 → 食堂区），保证同一批数据永远算出同一个结果。
       全部区域 0 分时判定为「暂无优先关注」。</p>
    <div class="kpis">
        {kpi_priority}
    </div>
{build_priority(stats['priority'])}
    <h3 class="sub-head">最近感知记录</h3>
    <p class="lead">各区域数据末尾的一条感知记录。source 固定为 review，confidence 固定为 null。</p>
{build_perception(stats['perception'])}
  </section>

  <footer class="page">本报告由 python_analysis/analysis.py 自动生成 · 所有图表与结论均基于当前 CSV 实时计算</footer>
</div>
</body>
</html>
"""


# ---------------------------------------------------------------------------
# 9. 主流程
# ---------------------------------------------------------------------------

_ENV_PRINTED = False


def generate_report(open_browser: bool = True) -> dict:
    """跑完整条分析链：data/history.csv ──► report/report.html。

    open_browser=False 供 serve.py 常驻调用——它自己管浏览器，
    每次重跑都开一个新标签页会刷屏。

    返回一份摘要（行数 / 区域数 / 异常数 / 报告体积 / 耗时），
    监视服务拿它写状态条；出错时照旧走 die() 抛 SystemExit。
    """
    global _ENV_PRINTED

    started = datetime.now()
    print("=" * 68)
    print("AirGuard 离线分析链 A —— 历史数据时空统计与趋势分析")
    print("=" * 68)
    # 环境信息每次重跑都一样，只在首次打印，免得刷屏
    if not _ENV_PRINTED:
        _ENV_PRINTED = True
        print(f"  Python      : {sys.version.split()[0]}  ({sys.executable})")
        fonts = setup_font()
        if fonts:
            print(f"  中文字体    : {fonts[0]}")
        print(f"  数据文件    : {CSV_PATH}")

    if not CSV_PATH.exists():
        die(
            "找不到数据文件：" + str(CSV_PATH),
            "请确认 data 目录下存在 history.csv。\n"
            "这个文件可以从 Web 监测大屏右上角的「导出 CSV」按钮下载得到。",
        )

    print("\n[1/4] 读取并校验 CSV …")
    raw = load_csv()
    df, quality = clean(raw)
    if df.empty:
        die("清洗后没有任何可用记录（三个指标全为空），无法生成报告。")
    print(f"      读入 {quality['rows_read']} 行，有效 {len(df)} 行")

    print("[2/4] 统计计算 …")
    stats = compute_stats(df)
    print(f"      区域 {len(stats['zones'])} 个 · 异常 {len(stats['abnormal'])} 条 · "
          f"时间跨度 {fmt_span(stats['span'])}")

    print("[3/4] 绘制图表 …")
    charts = {
        "trend": chart_trend(df, stats["zones"]),
        "zoom": chart_zone_compare(stats["zones"]),
        "crowd": chart_crowd_mix(stats["zones"]),
    }
    print("      " + " · ".join(f"{k}={'OK' if v else '跳过'}" for k, v in charts.items()))

    print("[4/4] 生成报告 …")
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    REPORT_PATH.write_text(
        build_html(df, stats, quality, charts, started.strftime("%Y-%m-%d %H:%M:%S")),
        encoding="utf-8",
    )
    size_kb = REPORT_PATH.stat().st_size / 1024
    print(f"      {REPORT_PATH}  ({size_kb:.0f} KB)")

    elapsed = (datetime.now() - started).total_seconds()
    if open_browser:
        print("\n完成，用时 %.1f 秒。正在打开浏览器 …" % elapsed)
        webbrowser.open(REPORT_PATH.as_uri())
    else:
        print("\n完成，用时 %.1f 秒。" % elapsed)

    return {
        "rows_read": int(quality["rows_read"]),
        "rows": int(len(df)),
        "zones": len(stats["zones"]),
        "abnormal": len(stats["abnormal"]),
        "report": str(REPORT_PATH),
        "bytes": int(REPORT_PATH.stat().st_size),
        "seconds": elapsed,
    }


def main() -> None:
    """双击 / 命令行入口：跑一次分析，然后打开浏览器看报告。"""
    generate_report(open_browser=True)


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        # 双击运行时窗口会一闪而过，所以出错要把 traceback 打印出来再停住
        print("\n" + "=" * 68)
        print("执行过程中出现未预期的错误：")
        print("=" * 68)
        traceback.print_exc()
        if sys.stdin and sys.stdin.isatty():
            try:
                input("\n按回车键关闭窗口…")
            except (EOFError, OSError):
                pass
        sys.exit(1)
