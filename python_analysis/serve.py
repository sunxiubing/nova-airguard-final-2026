#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
============================================================================
AirGuard 离线分析链 A —— 监视预览服务
============================================================================

用法
----
双击同目录下的 实时报告.bat（或直接双击本文件）。**启动一次就够了，一直开着。**

    data/history.csv 一变  ──►  自动重跑分析  ──►  report/report.html 更新
                                                        │
                                          浏览器里的报告页自己发现新版本并刷新

也就是说：Web 大屏点「导出 CSV」→ 把文件覆盖到 data/ → 回到报告页
（连 F5 都不用按），最新报告已经在那儿了。

它做了什么
----------
1. 启动时先跑一遍完整分析，保证首屏就有报告
2. 起一个只监听 127.0.0.1 的小服务，把报告发到浏览器
3. 每秒钟看一眼 data/history.csv 的修改时间和大小，变了就重跑分析
4. 每导入一份新数据，先在 data/archive/ 里留一份带时间戳的副本
5. 订阅 MQTT Airguard/+/data（D5）：每收到一条报文就立刻算「固定规则判定 /
   轻量 ML 判定 / 是否一致 / 裁决」，写进报告的板块 6，页面自动刷新

D5 与离线分析互不干扰：板块 1–5 仍然只由 data/history.csv 决定，
D5 只读历史文件当 ML 基线，**不写** data/ 下的任何内容。

与 analysis.py 的关系
---------------------
分析逻辑全部复用 analysis.py，本文件只负责「什么时候跑」和「怎么送到浏览器」，
不重复实现任何统计或绘图。

安全边界
--------
· 只监听 127.0.0.1，同局域网的其他机器访问不到
· 不写 data/history.csv，只读；唯一会写的目录是 data/archive/ 和 report/
· 关闭这个窗口（或按 Ctrl+C）就停止，不留后台进程
============================================================================
"""

from __future__ import annotations

# 必须在 import analysis 之前设好：analysis 在 import 期就会做依赖自检，
# 缺库时要走「打印提示后退出」而不是「停下来等回车」，否则服务会卡死在这儿。
import os

os.environ["AIRGUARD_NO_PAUSE"] = "1"

import hashlib
import json
import shutil
import sys
import threading
import time
import traceback
import webbrowser
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(BASE_DIR))

import analysis  # noqa: E402  （路径要先插好，所以放在这里）
import d3_event  # noqa: E402
import d5  # noqa: E402

CSV_PATH = analysis.CSV_PATH
REPORT_PATH = analysis.REPORT_PATH
ARCHIVE_DIR = BASE_DIR / "data" / "archive"

# 端口从 8787 起找，被占了就顺延。只绑回环地址，不对外。
PORT_START = 8787
PORT_TRIES = 12

POLL_SECONDS = 1.0    # 多久看一眼 CSV
SETTLE_SECONDS = 0.6  # 改动后要稳定这么久才认为「复制完了」，避免读到半截文件

# ---------------------------------------------------------------------------
# D5：固定规则 × 轻量 ML 的实时判定
# ---------------------------------------------------------------------------
MQTT_HOST = "127.0.0.1"
MQTT_PORT = 1885              # Broker 的 TCP 端口（四个端页面连的是 8085，那是 websocket）
MQTT_TOPIC = "Airguard/+/data"
MQTT_IV_TOPIC = "Airguard/intervention/+"   # D3：各端广播的干预动作
MQTT_CLIENT_ID = f"airguard-d5-{os.getpid()}"

D5_ENGINE = d5.D5Engine()     # 内存态：收到的每条报文算一次，不落盘
D3_ENGINE = d3_event.D3Engine()   # D3 事件状态机（与四端同款规则）
D5_NOTE = "MQTT 未连接"        # 状态条上显示的一句话，由订阅线程维护
D5_DIRTY = threading.Event()  # 有新报文等着写进报告
D5_RENDER_AT = [0.0]          # 上一次因 D5 重跑的时刻
D5_DEBOUNCE = 0.8             # 防抖：连发报文时最多 0.8 秒重跑一次

# ---------------------------------------------------------------------------
# 共享状态：监视线程写，HTTP 线程读
# ---------------------------------------------------------------------------

STATE = {
    "version": 0,          # 每成功生成一次报告 +1，页面靠它判断要不要刷新
    "generatedAt": None,   # 报告生成时刻
    "rows": None,          # 这份报告用了多少行数据
    "csv": None,           # data/history.csv 的 stat 摘要
    "sha": None,           # 已分析内容的指纹，用来判断「真的变了没」
    "busy": False,
    "error": None,         # 最近一次失败的原因，成功后清空
    "archive": None,       # 本次数据在 archive 里的副本文件名
    "d5": {"note": D5_NOTE, "received": 0, "rejected": 0},   # D5 订阅状态，给状态条用
}
STATE_LOCK = threading.Lock()
RUN_LOCK = threading.Lock()   # 同一时刻只允许一次分析在跑
FORCE = threading.Event()     # 手动触发「立即重新分析」


def log(msg: str) -> None:
    print(f"[{datetime.now():%H:%M:%S}] {msg}", flush=True)


def stat_key():
    """(修改时间, 大小)——CSV 有没有被动过，看这两个就够了"""
    st = CSV_PATH.stat()
    return (st.st_mtime_ns, st.st_size)


def sha_of_csv() -> str:
    """内容指纹。光看 mtime 不行：重新复制一份一模一样的文件也会变 mtime，
    那会白跑一次分析，还会在 archive 里留下一份重复副本。"""
    h = hashlib.sha256()
    with open(CSV_PATH, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 16), b""):
            h.update(chunk)
    return h.hexdigest()


def archive_csv(digest: str) -> str | None:
    """给这份数据留一份带时间戳的副本，同一份内容只留一次。

    文件名里带指纹前缀，所以服务重启后再看到同样的内容也不会重复归档。
    """
    prefix = digest[:8]
    if any(ARCHIVE_DIR.glob(f"history_*_{prefix}.csv")):
        return None

    ARCHIVE_DIR.mkdir(parents=True, exist_ok=True)
    dst = ARCHIVE_DIR / f"history_{datetime.now():%Y%m%d_%H%M%S}_{prefix}.csv"
    shutil.copy2(CSV_PATH, dst)
    return dst.name


def d5_mqtt_loop() -> None:
    """D5：订阅 Airguard/+/data，每条报文算一次判定，然后让报告重跑。

    Broker 没起来不算错误——后台一直重试就行（现场常常是先开报告页、再开 Broker）。
    收到报文只更新内存里的 D5 引擎，**不写** data/ 下的任何文件。
    """
    global D5_NOTE

    try:
        import paho.mqtt.client as mqtt
    except Exception as exc:  # noqa: BLE001
        D5_NOTE = f"缺少 paho-mqtt（{type(exc).__name__}），D5 只显示占位卡片"
        log(D5_NOTE)
        return

    def on_connect(client, userdata, flags, reason_code, properties=None):
        failed = getattr(reason_code, "is_failure", None)
        ok = (not failed) if failed is not None else (reason_code == 0)
        if ok:
            client.subscribe([(MQTT_TOPIC, 1), (MQTT_IV_TOPIC, 1)])
            log(f"D5/D3 已连接 Broker {MQTT_HOST}:{MQTT_PORT}，"
                f"订阅 {MQTT_TOPIC} 与 {MQTT_IV_TOPIC}")
        else:
            log(f"D5/D3 连接被 Broker 拒绝：{reason_code}")

    def on_disconnect(client, userdata, *args):
        log("D5 与 Broker 断开，后台自动重连…")

    def on_message(client, userdata, msg):
        try:
            payload = json.loads(msg.payload.decode("utf-8", "replace"))
        except Exception:  # noqa: BLE001
            return                     # 不是合法 JSON：与四端同一口径，直接丢
        if not isinstance(payload, dict):
            return

        topic = msg.topic or ""
        if topic.startswith("Airguard/intervention/"):
            # D3：别的端广播来的干预动作。event_id 对不上就只在报告里留一句说明
            if D3_ENGINE.receive_intervention(payload) is not None:
                log(f"D3 收到干预广播 {topic}：{payload.get('actions')}"
                    f"（{payload.get('actor', '?')}）")
                D5_DIRTY.set()
            return

        # 数据报文：D5（规则 × ML）与 D3（事件状态机）各算一遍，互不影响
        d5_rec = D5_ENGINE.feed(topic, payload)
        D3_ENGINE.feed(topic, payload)
        if d5_rec is None:
            return                     # 串区 / 区域认不出来：丢弃，不进报告
        D5_DIRTY.set()

    if hasattr(mqtt, "CallbackAPIVersion"):
        client = mqtt.Client(mqtt.CallbackAPIVersion.VERSION2, client_id=MQTT_CLIENT_ID)
    else:
        client = mqtt.Client(client_id=MQTT_CLIENT_ID)
    client.on_connect = on_connect
    client.on_disconnect = on_disconnect
    client.on_message = on_message
    client.reconnect_delay_set(min_delay=1, max_delay=10)
    client.connect_async(MQTT_HOST, MQTT_PORT, keepalive=30)
    client.loop_start()

    while True:
        time.sleep(1.0)
        note = ("MQTT 已连接 · 判定随报文实时更新" if client.is_connected()
                else f"MQTT 未连接（正在重试 {MQTT_HOST}:{MQTT_PORT}，请确认 Broker 已启动）")
        if note != D5_NOTE:
            D5_NOTE = note
            D5_DIRTY.set()             # 这句话也要出现在报告里，顺手刷新一次
        with STATE_LOCK:
            STATE["d5"] = {"note": D5_NOTE, "received": D5_ENGINE.received,
                           "rejected": D5_ENGINE.rejected}


def regenerate(reason: str, reload_analysis: bool = False) -> None:
    """跑一次分析并更新共享状态。任何异常都吞在这里——服务不能因为一份坏 CSV 就死。"""
    if not RUN_LOCK.acquire(blocking=False):
        return   # 上一次还没跑完，等下一轮
    try:
        with STATE_LOCK:
            STATE["busy"] = True
        log(f"重新生成报告（{reason}）…")
        started = time.monotonic()

        if reload_analysis:
            # 手动触发时重新加载分析模块：服务常驻期间改了 analysis.py，
            # 不重载的话跑的还是内存里那份旧代码。放在 RUN_LOCK 里做——
            # importlib.reload 不是线程安全的，不能和正在跑的分析重叠。
            try:
                import importlib

                importlib.reload(analysis)
                log("已重新加载 analysis.py，改动即时生效")
            except Exception as exc:  # noqa: BLE001
                log(f"重新加载 analysis.py 失败，继续用当前版本：{exc}")

        try:
            # 板块 6：把实时引擎交给分析链，它先用本次读到的 CSV 历史行预填（去重，重复预填不会灌两遍），
            # 再连实时报文一起渲染——所以报告一打开就有历史判定，新报文来了再往上叠
            D5_ENGINE.note = D5_NOTE
            D3_ENGINE.note = D5_NOTE
            info = analysis.generate_report(open_browser=False, d5_engine=D5_ENGINE,
                                            d3_engine=D3_ENGINE)
        except SystemExit as exc:
            # analysis.die() 走的是这条路：提示已经打过了，记下状态继续盯着
            with STATE_LOCK:
                STATE["error"] = f"分析中止（退出码 {exc.code}），详见上方提示"
                STATE["busy"] = False
            return
        except Exception as exc:  # noqa: BLE001
            traceback.print_exc()
            with STATE_LOCK:
                STATE["error"] = f"{type(exc).__name__}: {exc}"
                STATE["busy"] = False
            return

        digest = sha_of_csv()
        archived = archive_csv(digest)

        with STATE_LOCK:
            STATE["version"] += 1
            STATE["generatedAt"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            STATE["rows"] = info["rows"]
            STATE["csv"] = {"size": CSV_PATH.stat().st_size, "mtime": stat_key()[0]}
            STATE["sha"] = digest
            STATE["archive"] = archived
            STATE["error"] = None
            STATE["busy"] = False

        elapsed = time.monotonic() - started
        log(f"完成：{info['rows']} 行 · {info['zones']} 个区域 · "
            f"{info['bytes'] / 1024:.0f} KB · 用时 {elapsed:.1f} 秒"
            + (f" · 已归档 {archived}" if archived else ""))
    finally:
        RUN_LOCK.release()


def watch_loop() -> None:
    """盯着 data/history.csv，变了就重跑。

    第一次跑在服务启动之前（见 __main__），所以这里从「已处理过当前文件」开始。
    """
    try:
        last_key = stat_key()
    except OSError:
        last_key = None
    settled_since = None

    while True:
        time.sleep(POLL_SECONDS)

        # D5 收到新报文：重跑一次报告，把最新判定写进板块 6。
        # 连发时按 D5_DEBOUNCE 防抖，重跑期间又来的报文留到下一轮。
        if D5_DIRTY.is_set() and time.monotonic() - D5_RENDER_AT[0] >= D5_DEBOUNCE:
            D5_DIRTY.clear()
            D5_RENDER_AT[0] = time.monotonic()
            seen = D5_ENGINE.received
            regenerate("D5 收到新 MQTT 报文")
            if D5_ENGINE.received != seen or STATE["busy"]:
                D5_DIRTY.set()   # 渲染期间又来报文 / 刚才没抢到锁，下一轮补上
            continue

        if FORCE.is_set():
            FORCE.clear()
            settled_since = None
            try:
                last_key = stat_key()
            except OSError:
                last_key = None
            regenerate("手动触发", reload_analysis=True)
            continue

        try:
            key = stat_key()
        except OSError:
            continue   # 文件被删了或正被别的程序占着，下一轮再看

        if key != last_key:
            # 内容才刚变，可能还在复制中，先记下来等它稳定
            last_key = key
            settled_since = time.monotonic()
            continue

        if settled_since is None:
            continue   # 这一版已经分析过了，等下一次变化
        if time.monotonic() - settled_since < SETTLE_SECONDS:
            continue

        settled_since = None
        try:
            if sha_of_csv() == STATE["sha"]:
                log("文件动了但内容没变，跳过")
                continue
        except OSError:
            continue
        regenerate("data/history.csv 已更新")


# ---------------------------------------------------------------------------
# 报告页增强：只作用在 HTTP 响应上，磁盘上的 report.html 保持原样
# ---------------------------------------------------------------------------
# 为什么不在 analysis.py 里生成：报告是自包含、可单独分享的文件，
# 不该塞进「只有本机服务在跑时才有意义」的轮询脚本。

WATCH_SNIPPET = r"""
<div id="ag-watch" style="position:fixed;right:16px;bottom:16px;z-index:99999;
     display:flex;align-items:center;gap:10px;padding:9px 14px;border-radius:999px;
     background:rgba(17,24,39,.92);color:#f9fafb;font:13px/1.4 system-ui,'Microsoft YaHei',sans-serif;
     box-shadow:0 6px 24px rgba(0,0,0,.28);backdrop-filter:blur(6px)">
  <span id="ag-dot" style="width:8px;height:8px;border-radius:50%;background:#22c55e;flex:0 0 auto"></span>
  <span id="ag-msg">正在连接本地监视服务…</span>
  <button id="ag-rerun" style="border:1px solid rgba(255,255,255,.35);background:transparent;
          color:inherit;font:inherit;padding:3px 10px;border-radius:999px;cursor:pointer">重新分析</button>
</div>
<script>
(function () {
  var seen = null, dot = document.getElementById('ag-dot'), msg = document.getElementById('ag-msg');
  function paint(text, color) { msg.textContent = text; dot.style.background = color; }

  function poll() {
    fetch('/api/status', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (s) {
      if (seen === null) {
        seen = s.version;
      } else if (s.version !== seen) {
        paint('检测到新报告，正在刷新…', '#38bdf8');
        location.reload();
        return;
      }
      if (s.busy) { paint('正在重新分析…', '#facc15'); return; }
      if (s.error) { paint('分析失败：' + s.error, '#ef4444'); return; }
      if (!s.generatedAt) { paint('等待 data/history.csv …', '#facc15'); return; }
      var d5txt = (s.d5 && s.d5.received) ? ' · D5 已收 ' + s.d5.received + ' 条' : '';
      paint('已连接 · ' + s.rows + ' 行 · 更新于 ' + s.generatedAt + d5txt, '#22c55e');
    }).catch(function () {
      paint('监视服务已断开，请重新运行 实时报告.bat', '#9ca3af');
    });
  }

  document.getElementById('ag-rerun').onclick = function () {
    paint('已请求重新分析…', '#facc15');
    fetch('/api/rerun', { method: 'POST' }).catch(function () {});
  };

  poll();
  setInterval(poll, 1000);
})();
</script>
"""

PLACEHOLDER = """<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<title>AirGuard 报告 · 等待数据</title>
<style>
 body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
      background:#f6f7f9;color:#1f2937;font:15px/1.7 system-ui,'Microsoft YaHei',sans-serif}
 .card{max-width:620px;padding:36px 40px;background:#fff;border-radius:14px;
       box-shadow:0 10px 40px rgba(15,23,42,.10)}
 h1{margin:0 0 14px;font-size:19px}
 code{background:#f3f4f6;padding:2px 6px;border-radius:5px;font-size:13px}
 .err{margin-top:18px;padding:12px 14px;border-left:3px solid #ef4444;background:#fef2f2;
      border-radius:0 8px 8px 0;color:#991b1b;font-size:13px;white-space:pre-wrap}
</style></head><body><div class="card">
<h1>还没有可显示的报告</h1>
<p>监视服务正在运行，但 <code>data/history.csv</code> 还没能生成报告。</p>
<p>把 Web 大屏导出的 <code>history.csv</code> 覆盖到 <code>python_analysis/data/</code>，
这个页面会自动出现报告。</p>
__ERROR__
</div>__SNIPPET__</body></html>
"""


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------

class Handler(BaseHTTPRequestHandler):
    server_version = "AirGuardWatch"

    def log_message(self, fmt, *args):   # 默认每个请求都刷一行，轮询下太吵
        pass

    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        # 报告是每次刷新都要拿最新的，一律禁缓存
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass   # 轮询期间用户刷新 / 关页面，正常现象

    def _json(self, obj) -> None:
        self._send(200, json.dumps(obj, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def do_GET(self) -> None:
        path = self.path.split("?", 1)[0]

        if path == "/api/status":
            with STATE_LOCK:
                snapshot = dict(STATE)
            self._json(snapshot)
            return

        if path in ("/", "/index.html", "/report.html"):
            with STATE_LOCK:
                snapshot = dict(STATE)

            if REPORT_PATH.exists():
                page = REPORT_PATH.read_text(encoding="utf-8")
                if "</body>" in page:
                    page = page.replace("</body>", WATCH_SNIPPET + "</body>", 1)
                else:
                    page += WATCH_SNIPPET
            else:
                err = (f'<div class="err">{snapshot["error"]}</div>'
                       if snapshot.get("error") else "")
                page = PLACEHOLDER.replace("__ERROR__", err).replace("__SNIPPET__", WATCH_SNIPPET)

            self._send(200, page.encode("utf-8"), "text/html; charset=utf-8")
            return

        if path == "/favicon.ico":
            self._send(204, b"", "image/x-icon")
            return

        self._send(404, "404".encode("utf-8"), "text/plain; charset=utf-8")

    def do_POST(self) -> None:
        if self.path.split("?")[0] == "/api/rerun":
            FORCE.set()
            log("收到手动重新分析请求")
            self._json({"ok": True})
            return
        self._send(404, b"404", "text/plain; charset=utf-8")


def pick_port() -> int:
    """从 PORT_START 起找一个能用的端口。只试回环地址，避免误判成「已被占用」。"""
    import socket

    for port in range(PORT_START, PORT_START + PORT_TRIES):
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    print(f"端口 {PORT_START}–{PORT_START + PORT_TRIES - 1} 都被占用了，"
          "请关掉占用这些端口的程序后重试。")
    sys.exit(1)


def main() -> None:
    print("=" * 68)
    print("AirGuard 离线分析链 A —— 监视预览服务")
    print("=" * 68)
    print(f"  数据文件    : {CSV_PATH}")
    print(f"  报告文件    : {REPORT_PATH}")
    print(f"  归档目录    : {ARCHIVE_DIR}")
    print()
    print(f"  MQTT 订阅   : {MQTT_TOPIC} @ {MQTT_HOST}:{MQTT_PORT}（D5 实时判定，Broker 没开也不影响报告）")
    print()
    print("  这个窗口要一直开着。以后只要把导出的 history.csv 覆盖到 data/，")
    print("  报告页会自己刷新，不用再回来敲命令。按 Ctrl+C 或关窗口即停止。")
    print("=" * 68 + "\n")

    # 先把首屏报告跑出来，再开服务——否则第一次打开浏览器会看到空白等待页
    if CSV_PATH.exists():
        regenerate("服务启动")
    else:
        log(f"还没看到 {CSV_PATH}，先起服务，等文件出现再分析")
        with STATE_LOCK:
            STATE["error"] = "data/history.csv 不存在"

    port = pick_port()
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    httpd.daemon_threads = True

    threading.Thread(target=watch_loop, daemon=True, name="watcher").start()
    threading.Thread(target=d5_mqtt_loop, daemon=True, name="d5-mqtt").start()

    url = f"http://127.0.0.1:{port}/"
    print(f"\n报告地址：{url}")
    print("（这个地址可以直接收藏，以后不用再启动本窗口也能打开——")
    print("  只是没有自动刷新，看到的会是上一次生成的报告）\n")

    # 自动化测试里不希望凭空弹出浏览器窗口
    if os.environ.get("AIRGUARD_NO_BROWSER") != "1":
        webbrowser.open(url)

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n已停止监视。")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
