/* ============================================================
   AirGuard 校园多区域空气质量与人流监测预警协同系统 · 移动巡检端
   业务逻辑：MQTT 订阅 → 结论重算 → 卡片渲染
   ------------------------------------------------------------
   数据链路：
       感知采集节点 → MQTT/JSON → 共享实时状态 → Web 监测大屏
                                                → 移动巡检端（本文件）
                                                → 地图 / 3D
   与 Web 大屏订阅同一条数据流： Airguard/+/data
   ------------------------------------------------------------
   设计要点：
   1. 页面不写死任何示例数据，启动时卡片为空，全部依赖 MQTT 推送；
   2. status 一律本地按任务书规则重算，不信任报文里的 status 字段；
   3. 区域识别走「主题 + 报文 zoneId」双通道校验，防止数据串区；
   4. 卡片的 DOM 结构只建一次，后续只改文本节点，保证手机端轻量。
   ============================================================ */

(function () {
  'use strict';

  /* ============================================================
     1. 配置
     ============================================================ */

  var CONFIG = {
    mqtt: {
      url: 'ws://127.0.0.1:8085',        // 与 Web 大屏共用同一个 Broker
      topic: 'Airguard/+/data',          // + 为区域通配符
      qos: 0,
      options: {
        clientId: 'airguard-mobile-' + Math.random().toString(16).slice(2, 10),
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 3000,           // 断线后每 3 秒自动重连
        keepalive: 30
      }
    },
    maxPerception: 30       // 感知记录在内存里保留的条数（不落盘，仅用于本次会话）
  };

  /* ============================================================
     2. 区域与结论常量表
     ============================================================ */

  /* 三个监测区域，数组顺序 = 卡片的地理固定顺序 */
  var ZONES = [
    { id: 'zone-n', name: '宿舍区' },
    { id: 'zone-s', name: '教学区' },
    { id: 'zone-w', name: '食堂区' }
  ];

  /* 环境维度结论：等级 → 严重度排序 / 文字 / 图形符号 / 处置建议
     icon 与文字同时出现，保证状态色不单独承载语义 */
  var LEVELS = {
    good: {
      rank: 0, label: '正常', icon: '✓',
      actions: ['维持现有通风与人员管理']
    },
    warning: {
      rank: 1, label: '轻度污染', icon: '▲',
      actions: ['减少长时间停留', '适时开窗换气']
    },
    serious: {
      rank: 2, label: '通风不足风险', icon: '⚠',
      actions: ['立即开窗加强通风', '疏散密集人群']
    },
    critical: {
      rank: 3, label: '重度污染', icon: '✕',
      actions: ['限制人员停留', '暂停室内活动', '开启空气净化设备']
    }
  };

  /* 感知维度结论：crowdLevel 数字 → 人流文字 */
  var CROWD_LEVELS = {
    0: '稀疏',
    1: '正常',
    2: '拥挤',
    3: '严重拥挤'
  };

  /* ------------------------------------------------------------
     持续风险与优先关注
     与 Web 大屏 / 地图3D / 分析报告用的是同一套规则，改动必须五处同步：

       总分 = 环境异常分 + 人流分
       环境异常分：末尾连续异常 0 条 = 0；1 条 = 1（单次异常）；≥2 条 = 3（连续多次异常）
       人流分：稀疏 0 / 正常 1 / 拥挤 2 / 严重拥挤 3

     取总分最高者为【当前优先关注】，平分依次比环境分、人流分，
     再按 ZONES 的固定顺序兜底，保证同一批数据永远算出同一个结果。
     ------------------------------------------------------------ */
  var PRIORITY_ENV_SINGLE = 1;     // 单次异常
  var PRIORITY_ENV_STREAK = 3;     // 连续多次异常
  var PRIORITY_SOURCE = 'review';  // 感知记录来源，全系统固定；confidence 固定为 null

  /* ============================================================
     3. 工具函数
     ============================================================ */

  /* 大小写不敏感的字段取值，兼容 zoneId / zoneid / zone_id 等不同写法 */
  function field(obj, names) {
    if (!obj || typeof obj !== 'object') return undefined;
    var map = {};
    for (var k in obj) {
      if (Object.prototype.hasOwnProperty.call(obj, k)) map[String(k).toLowerCase()] = obj[k];
    }
    for (var i = 0; i < names.length; i++) {
      var v = map[String(names[i]).toLowerCase()];
      if (v !== undefined && v !== null && v !== '') return v;
    }
    return undefined;
  }

  /* 区域标识归一化：zone-n / n / 宿舍区 / dorm 统一成 zone-n */
  var ZONE_ALIAS = {
    'zone-n': 'zone-n', 'n': 'zone-n', '宿舍区': 'zone-n', '宿舍': 'zone-n', 'dorm': 'zone-n',
    'zone-s': 'zone-s', 's': 'zone-s', '教学区': 'zone-s', '教学': 'zone-s', 'teach': 'zone-s',
    'zone-w': 'zone-w', 'w': 'zone-w', '食堂区': 'zone-w', '食堂': 'zone-w', 'canteen': 'zone-w'
  };

  function deriveZoneId(raw) {
    if (raw === undefined || raw === null) return null;
    var key = String(raw).trim().toLowerCase();
    return ZONE_ALIAS[key] || ZONE_ALIAS[key.replace(/^airguard\//, '')] || null;
  }

  /* 从主题里取区域段：Airguard/zone-n/data → zone-n */
  function zoneFromTopic(topic) {
    var seg = String(topic || '').split('/');
    for (var i = 0; i < seg.length; i++) {
      var id = deriveZoneId(seg[i]);
      if (id) return id;
    }
    return null;
  }

  /* 双通道区域校验：主题段与报文 zoneId 必须指向同一区域 */
  function resolveZone(topic, payload) {
    var fromTopic = zoneFromTopic(topic);
    var fromPayload = deriveZoneId(field(payload, ['zoneid', 'zone_id', 'zone', 'areaid', 'area']));

    if (fromTopic && fromPayload) {
      if (fromTopic !== fromPayload) {
        return { error: 'mismatch', detail: '主题指向 ' + fromTopic + '，报文 zoneId 却是 ' + fromPayload };
      }
      return { zoneId: fromTopic };
    }
    if (fromTopic) return { zoneId: fromTopic };
    if (fromPayload) return { zoneId: fromPayload };
    return { error: 'unknown', detail: '主题与报文都无法识别区域' };
  }

  /* 环境结论判定 —— 任务书规则，本地重算：
       pm25 > 150          → 重度污染
       pm25 > 75           → 轻度污染
       co2 ≥ 1500（pm25≤75）→ 通风不足风险
       其余                → 正常                                        */
  function evaluateLevel(pm25, co2) {
    if (typeof pm25 === 'number' && pm25 > 150) return 'critical';
    if (typeof pm25 === 'number' && pm25 > 75) return 'warning';
    if (typeof co2 === 'number' && co2 >= 1500) return 'serious';
    return 'good';
  }

  /* 宽松数值解析：字符串数字也接受，无法解析返回 null */
  function toNum(v) {
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string' && v.trim() !== '') {
      var n = Number(v.trim());
      return isFinite(n) ? n : null;
    }
    return null;
  }

  /* 更新时间只显示「时:分:秒」，完整值挂到 title 上 */
  function formatTime(raw) {
    if (raw === undefined || raw === null || raw === '') return '—';
    var s = String(raw).trim();
    var m = s.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*$/);
    return m ? m[1] : s;
  }

  /* ============================================================
     3-b. 本地持久化：纯函数部分
     写盘策略与 Web 大屏、三维沙盘保持一致：
       MQTT 收到一条 → 进内存 historyRecords → 节流 400ms 落盘
       刷新 / 重开 → 读回 → 按区域还原成「缓存读数」卡片
     只负责记录与还原，不参与任何结论判定，原有 MQTT / 告警链路不受影响
     ============================================================ */

  var HISTORY = {
    key: 'airguard.history.mobile.v1',   // 与 web / map3d 的键各自独立，同源也不互相覆盖
    limit: 5000,                         // 超出丢最旧
    debounceMs: 400                      // setItem 是同步阻塞的，攒一攒再写
  };

  /* 内存里的历史记录。始终原地增删，绝不整体重新赋值，
     否则外部（调试台 / 自动化验证）提前拿到的引用会指向旧数组 */
  var historyRecords = [];

  /* 清空后的一次性回执，下一条实时报文到达即让位 */
  var clearNote = null;
  /* 本次画面的数据来自本地存档时，记下来源，供页脚交代 */
  var restoreInfo = null;
  /* 感知记录编号：zoneId → 该区域本次会话已产生的条数（imageId 里的序号） */
  var perceptionSeq = {};

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* 各种时间写法归一成 Date：数字按秒 / 毫秒，纯时间按今天，其余交给 Date 解析 */
  function toDate(value) {
    if (value === undefined || value === null || value === '') return null;
    if (value instanceof Date) return isNaN(value.getTime()) ? null : value;

    if (typeof value === 'number') {
      var ms = value < 1e12 ? value * 1000 : value;   // 10 位当秒，13 位当毫秒
      var dn = new Date(ms);
      return isNaN(dn.getTime()) ? null : dn;
    }

    var s = String(value).trim();
    if (s === '') return null;

    var t = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (t) {
      var now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(),
        Number(t[1]), Number(t[2]), Number(t[3] || 0));
    }

    var d = new Date(s.replace(/-/g, '/'));   // Safari 不认 "YYYY-MM-DD HH:MM:SS"
    return isNaN(d.getTime()) ? null : d;
  }

  function fmtStampFull(value) {
    var d = toDate(value);
    if (!d) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* 页脚用的短时间戳 MM-DD HH:MM:SS */
  function fmtStampShort(value) {
    var d = toDate(value);
    if (!d) return '';
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* 存档条目基本形态校验：脏条目逐条滤掉，一条坏数据不该毁掉整份存档 */
  function isValidRecord(r) {
    return !!r && typeof r === 'object' && !Array.isArray(r) &&
           typeof r.time === 'string' && r.time !== '' &&
           deriveZoneId(r.zone) !== null;
  }

  /* 实时报文 → 存档条目。字段顺序与任务书 CSV 表头一致：
       time,zone,pm25,co2,crowdLevel,status
     取值一律照抄报文原值（不四舍五入、不裁剪），存档即原始事实 */
  function toRecord(reading) {
    return {
      time: fmtStampFull(reading.time) || fmtStampFull(new Date()),
      zone: reading.zoneId,
      pm25: reading.pm25,
      co2: reading.co2,
      crowdLevel: reading.crowdLevel,
      status: reading.reportedStatus === undefined ? null : reading.reportedStatus
    };
  }

  function trimRecords(arr, limit) {
    var over = arr.length - limit;
    if (over > 0) arr.splice(0, over);
    return arr;
  }

  /* ============================================================
     4. 共享实时状态
     与 Web 大屏同构：所有展示都从这一份状态派生，避免多处各存一份
     ============================================================ */

  var Store = {
    zones: {},                                  // zoneId → 最新一条结论
    counters: { messages: 0, rejected: 0 },
    listeners: [],
    streaks: {},                                // zoneId → 末尾连续异常条数
    streakStart: {},                            // zoneId → 本轮连续异常首条记录的时刻（ms）
    perception: [],                             // 感知记录，最新在前，上限 CONFIG.maxPerception
    priority: { rows: [], winner: null },       // 优先关注打分结果

    subscribe: function (fn) { this.listeners.push(fn); },

    notify: function () {
      for (var i = 0; i < this.listeners.length; i++) this.listeners[i]();
    },

    /* 处理一条 MQTT 报文：解析 → 区域校验 → 结论重算 → 通知渲染
       opts.cached = true 表示这是从本地存档回灌的画面，不是新收到的报文 */
    ingest: function (topic, raw, opts) {
      var cached = !!(opts && opts.cached);
      var payload;

      try {
        payload = JSON.parse(raw);
      } catch (e) {
        this.counters.rejected++;
        console.warn('[AirGuard] 报文不是合法 JSON，已丢弃：', raw);
        this.notify();
        return false;
      }

      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        this.counters.rejected++;
        console.warn('[AirGuard] 报文不是对象，已丢弃：', raw);
        this.notify();
        return false;
      }

      // —— 双通道区域校验，不一致直接丢弃，防止数据串区 ——
      var resolved = resolveZone(topic, payload);
      if (resolved.error) {
        this.counters.rejected++;
        console.warn('[AirGuard] 区域校验失败（' + resolved.error + '）：' + resolved.detail, '主题 =', topic, '报文 =', payload);
        this.notify();
        return false;
      }

      var zoneId = resolved.zoneId;
      var pm25 = toNum(field(payload, ['pm25', 'pm2.5', 'pm2_5']));
      var co2 = toNum(field(payload, ['co2', 'co_2', 'co2ppm']));
      var crowdLevel = toNum(field(payload, ['crowdlevel', 'crowd_level', 'crowd']));
      var reportedStatus = field(payload, ['status']);
      var time = field(payload, ['time', 'timestamp', 'ts']);

      // —— 环境结论一律本地重算，不信任报文 status ——
      var level = evaluateLevel(pm25, co2);

      // 上报值与本地重算不符时留痕，便于排查采集端规则是否同步
      if (reportedStatus !== undefined && String(reportedStatus).trim() !== LEVELS[level].label) {
        console.warn('[AirGuard] ' + zoneId + ' 上报 status="' + reportedStatus +
                     '"，本地按规则重算为 "' + LEVELS[level].label + '"，以本地结论为准');
      }

      // —— 感知结论：数字转文字 ——
      var crowdText;
      if (crowdLevel === null) {
        crowdText = '—';
      } else if (Object.prototype.hasOwnProperty.call(CROWD_LEVELS, crowdLevel)) {
        crowdText = CROWD_LEVELS[crowdLevel];
      } else {
        crowdText = '未知（' + crowdLevel + '）';   // 超出 0–3 的取值如实暴露，不静默吞掉
      }

      var reading = this.zones[zoneId] = {
        zoneId: zoneId,
        pm25: pm25,
        co2: co2,
        crowdLevel: crowdLevel,
        crowdText: crowdText,
        level: level,
        reportedStatus: reportedStatus,
        time: time,
        // 解析成毫秒：持续时长要按报文时间戳做减法，字符串没法比
        ts: (toDate(time) || new Date()).getTime(),
        cached: cached        // 一旦来了实时报文，下一次就自动脱掉缓存标记
      };

      /* 连续异常计数：正常即归零。刷新页面后从头算起——
         存档回灌只有每区域最后一条记录，「连续了几次」无从得知，按单次计。
         这是本模块已知的口径损耗：连续分只在页面存活期间累积。 */
      if (level === 'good') {
        this.streaks[zoneId] = 0;
        this.streakStart[zoneId] = null;
      } else if (cached) {
        /* 回放只知道「末尾这条是异常」，连续了几次、从哪一刻起都无从得知，
           按单次计，起点也只能记成这条自己 —— 时长自然是 0 */
        this.streaks[zoneId] = 1;
        this.streakStart[zoneId] = reading.ts;
      } else {
        // 0 → 1 是本轮连续异常的起点，只有这一跳才写 streakStart
        if (!this.streaks[zoneId]) this.streakStart[zoneId] = reading.ts;
        this.streaks[zoneId] = (this.streaks[zoneId] || 0) + 1;
      }

      // 存档回灌只负责把画面恢复成上次看到的样子：
      // 不计消息数、不入历史、不写盘，否则每次刷新都会凭空多出数据
      if (cached) {
        computePriority();
        this.notify();
        return true;
      }

      clearNote = null;
      this.counters.messages++;
      addPerception(reading);
      historyRecords.push(toRecord(reading));
      trimRecords(historyRecords, HISTORY.limit);
      scheduleSave();
      computePriority();
      this.notify();
      return true;
    },

    /* 当前有多少个区域显示的是本地缓存读数 */
    cachedCount: function () {
      var n = 0;
      for (var id in this.zones) {
        if (Object.prototype.hasOwnProperty.call(this.zones, id) && this.zones[id].cached) n++;
      }
      return n;
    },

    /* 清空内存态：区域读数、计数器、连续异常与优先关注全部归零
       （本地存储由 clearHistory 负责） */
    clearAll: function () {
      for (var id in this.zones) {
        if (Object.prototype.hasOwnProperty.call(this.zones, id)) delete this.zones[id];
      }
      for (var sid in this.streaks) {
        if (Object.prototype.hasOwnProperty.call(this.streaks, sid)) delete this.streaks[sid];
      }
      for (var stid in this.streakStart) {
        if (Object.prototype.hasOwnProperty.call(this.streakStart, stid)) delete this.streakStart[stid];
      }
      for (var pid in perceptionSeq) {
        if (Object.prototype.hasOwnProperty.call(perceptionSeq, pid)) delete perceptionSeq[pid];
      }
      this.perception.length = 0;                 // 就地清空：数组引用不变
      this.priority.rows.length = 0;
      this.priority.winner = null;
      this.counters.messages = 0;
      this.counters.rejected = 0;
      this.notify();
    }
  };

  /* ============================================================
     4b. 持续风险与优先关注
     感知记录：每条通过校验的报文派生一条，字段与另外四端一致。
     source 与 confidence 在本系统里没有真实来源，写死而不是留空，
     是为了让「这条记录是怎么来的」在界面上一眼可见。
     ============================================================ */

  /* 人流分：稀疏 0 / 正常 1 / 拥挤 2 / 严重拥挤 3。
     缺失或超出 0–3 的取值一律夹到范围内再打分 —— 打分要的是一个确定的数，
     而卡片上的感知结论仍然如实显示原始取值（见 ingest 里的 crowdText）。 */
  function crowdScore(v) {
    if (v === null || v === undefined || !isFinite(v)) return 0;
    return clamp(Math.round(v), 0, 3);
  }

  function addPerception(reading) {
    var n = (perceptionSeq[reading.zoneId] || 0) + 1;
    perceptionSeq[reading.zoneId] = n;
    Store.perception.unshift({
      zoneId: reading.zoneId,
      // 真实系统里这里是抓拍图编号；本地没有图片，用「相机 + 区域 + 该区域第几条」
      // 拼出来，既能唯一标识，也比随机数好核对
      imageId: 'cam-' + reading.zoneId + '-' + String(n).padStart(4, '0'),
      crowdLevel: CROWD_LEVELS[crowdScore(reading.crowdLevel)],
      confidence: null,
      source: PRIORITY_SOURCE,
      // 完整到日期：感知记录是存档性质的，只写 HH:MM:SS 跨天就没法核对了
      time: fmtStampFull(reading.time) || fmtStampFull(new Date())
    });
    if (Store.perception.length > CONFIG.maxPerception) {
      Store.perception.length = CONFIG.maxPerception;
    }
  }

  /* 时长文案：不足 1 分 → 「N 秒」；不足 1 时 → 「M 分 S 秒」；再长 → 「H 时 M 分」 */
  function spanText(ms) {
    var s = Math.max(0, Math.floor((ms || 0) / 1000));
    if (s < 60) return s + ' 秒';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' 分 ' + (s % 60) + ' 秒';
    return Math.floor(m / 60) + ' 时 ' + (m % 60) + ' 分';
  }

  function priorityReason(r) {
    var envTxt;
    if (r.env === 0) {
      envTxt = '环境正常 0 分';
    } else if (r.streak === 1) {
      envTxt = '环境单次异常（' + r.levelLabel + '）' + PRIORITY_ENV_SINGLE + ' 分';
    } else {
      envTxt = '环境连续 ' + r.streak + ' 次异常（' + r.levelLabel + '）已持续 ' +
               spanText(r.span) + ' ' + PRIORITY_ENV_STREAK + ' 分';
    }
    return envTxt + ' + 人流' + r.crowdLabel + ' ' + r.crowd + ' 分 → 总分 ' + r.total;
  }

  /* 同分裁决链的比较器：返回负数表示 a 更该先看。
     前四级全平时返回 0，由调用方的「严格更优才换人」保持 ZONES 的先后。 */
  function comparePriority(a, b) {
    if (a.total !== b.total) return b.total - a.total;
    if (a.span !== b.span) return b.span - a.span;
    if (a.env !== b.env) return b.env - a.env;
    if (a.crowd !== b.crowd) return b.crowd - a.crowd;
    return 0;
  }

  /* 裁决理由：回答「凭什么是它」。rival 是按同一裁决链排出来的第二名。 */
  function priorityVerdict(win, rival) {
    if (!rival || rival.total !== win.total) {
      return win.name + '总分 ' + win.total + ' 为三区最高' +
             (rival ? '（次高 ' + rival.total + ' 分）' : '') + '，综合风险最该先处理';
    }
    var head = '与' + rival.name + '同为 ' + win.total + ' 分';
    if (win.span !== rival.span) {
      return head + '；' + win.name + '环境异常已持续 ' + spanText(win.span) +
             '，比' + rival.name + '（' + spanText(rival.span) + '）更久，故先处理';
    }
    if (win.env !== rival.env) {
      return head + '、持续时长相同；' + win.name + '环境异常分更高（' +
             win.env + ' 对 ' + rival.env + '），故先处理';
    }
    if (win.crowd !== rival.crowd) {
      return head + '、持续时长与环境分均相同；' + win.name + '人流密度等级更高（' +
             win.crowdLabel + ' 对 ' + rival.crowdLabel + '），故先处理';
    }
    return head + '且各分项完全相同，按固定区域顺序取' + win.name;
  }

  function computePriority() {
    var rows = [];

    for (var i = 0; i < ZONES.length; i++) {
      var zid = ZONES[i].id;
      var d = Store.zones[zid];
      if (!d) continue;

      var streak = Store.streaks[zid] || 0;
      var env = streak === 0 ? 0
              : (streak === 1 ? PRIORITY_ENV_SINGLE : PRIORITY_ENV_STREAK);
      var crowd = crowdScore(d.crowdLevel);
      /* 持续时间只看本轮连续异常：末条记录时刻 − 首条记录时刻。
         streak 为 0 或 1 时首末同一条，时长 0 */
      var started = Store.streakStart[zid];
      var span = (streak > 0 && started != null) ? Math.max(0, d.ts - started) : 0;
      var row = {
        zoneId: zid,
        name: ZONES[i].name,
        streak: streak,
        span: span,
        spanText: spanText(span),
        level: d.level,
        levelLabel: LEVELS[d.level].label,
        env: env,
        crowd: crowd,
        crowdLabel: CROWD_LEVELS[crowd],
        total: env + crowd
      };
      row.reason = priorityReason(row);
      rows.push(row);
    }

    /* 按 ZONES 的固定顺序遍历。裁决链前四级全平时先到先得，等于「区域顺序」兜底，
       同一批数据算出来永远是同一个结果，不会在两个区域之间来回跳。 */
    var winner = null, rival = null, j;
    for (j = 0; j < rows.length; j++) {
      if (!winner || comparePriority(rows[j], winner) < 0) winner = rows[j];
    }
    for (j = 0; j < rows.length; j++) {
      if (rows[j] === winner) continue;
      if (!rival || comparePriority(rows[j], rival) < 0) rival = rows[j];
    }

    /* 全员 0 分 = 没有需要特别关注的区域，这本身就是结论，
       不该硬塞一个 0 分的区域上去凑数 */
    var top = (winner && winner.total > 0) ? winner : null;
    if (top) top.verdict = priorityVerdict(top, rival);
    Store.priority = { rows: rows, winner: top };
  }

  /* ============================================================
     5. 渲染层
     ============================================================ */

  var els = {};

  /* 所有需要缓存的元素 id —— 漏一个就会在 render 时抛错 */
  var IDS = [
    'appBar', 'connText', 'connDetail',
    'priorityBanner', 'priorityTag', 'priorityZone', 'priorityTotalRow', 'priorityTotal',
    'prioritySplit', 'priorityReason', 'priorityVerdict',
    'alertBanner', 'alertChips', 'allClear',
    'zoneList', 'emptyHint', 'msgCount', 'rejectCount', 'restoreNote'
  ];

  var cards = {};        // zoneId → { el, 各文本节点引用 }

  function cacheEls() {
    for (var i = 0; i < IDS.length; i++) els[IDS[i]] = document.getElementById(IDS[i]);
  }

  /* 建立一张卡片的静态骨架，返回各文本节点的引用供后续更新 */
  function buildCard(zone) {
    var el = document.createElement('article');
    el.className = 'zone-card';
    el.setAttribute('data-level', 'idle');
    el.setAttribute('data-rank', 'none');
    el.setAttribute('aria-label', zone.name + ' 监测卡片');

    el.innerHTML =
      '<div class="zone-body">' +
        '<div class="zone-head">' +
          '<div class="zone-title">' +
            '<h2 class="zone-name"></h2>' +
            '<span class="zone-id"></span>' +
            // 缓存读数标记：压在区域名后面，而不是替换状态胶囊——颜色仍然只表示结论等级
            '<span class="cached-pill" hidden>本地缓存</span>' +
          '</div>' +
          '<span class="status-pill">' +
            '<span class="pill-icon" aria-hidden="true"></span>' +
            '<span class="pill-text"></span>' +
          '</span>' +
        '</div>' +

        '<div class="metric-row">' +
          '<div class="metric">' +
            '<p class="metric-label">PM2.5</p>' +
            '<p class="metric-value"><b class="v-pm25">—</b><span class="metric-unit">μg/m³</span></p>' +
          '</div>' +
          '<div class="metric">' +
            '<p class="metric-label">CO₂</p>' +
            '<p class="metric-value"><b class="v-co2">—</b><span class="metric-unit">ppm</span></p>' +
          '</div>' +
        '</div>' +

        '<div class="conclusion">' +
          '<div class="conclusion-grid">' +
            '<div class="conclusion-cell">' +
              '<p class="conclusion-label">环境结论</p>' +
              '<p class="v-status conclusion-value">等待数据</p>' +
            '</div>' +
            '<div class="conclusion-cell">' +
              '<p class="conclusion-label">感知结论</p>' +
              '<p class="v-crowd conclusion-value">等待数据</p>' +
            '</div>' +
          '</div>' +
          '<p class="conclusion-update">' +
            '<span class="conclusion-label">更新时间</span>' +
            '<span class="v-time">—</span>' +
          '</p>' +
        '</div>' +

        '<div class="action-box" hidden>' +
          '<p class="action-title">必要处置操作</p>' +
          '<ul class="action-list"></ul>' +
        '</div>' +
      '</div>';

    var refs = {
      el: el,
      name:     el.querySelector('.zone-name'),
      zoneId:   el.querySelector('.zone-id'),
      cachedPill: el.querySelector('.cached-pill'),
      pillIcon: el.querySelector('.pill-icon'),
      pillText: el.querySelector('.pill-text'),
      pm25:     el.querySelector('.v-pm25'),
      co2:      el.querySelector('.v-co2'),
      status:   el.querySelector('.v-status'),
      crowd:    el.querySelector('.v-crowd'),
      time:     el.querySelector('.v-time'),
      actionBox:  el.querySelector('.action-box'),
      actionList: el.querySelector('.action-list'),
      renderedLevel: null
    };

    refs.name.textContent = zone.name;
    refs.zoneId.textContent = zone.id;

    return refs;
  }

  function mountCards() {
    var frag = document.createDocumentFragment();
    for (var i = 0; i < ZONES.length; i++) {
      var c = buildCard(ZONES[i]);
      cards[ZONES[i].id] = c;
      frag.appendChild(c.el);
    }
    els.zoneList.appendChild(frag);
  }

  /* 更新单张卡片：只改文本节点，不动 DOM 结构 */
  function renderCard(zone, data) {
    var c = cards[zone.id];
    if (!c) return;

    // 该区域尚未上报：保持空态
    if (!data) {
      c.el.setAttribute('data-level', 'idle');
      c.el.setAttribute('data-rank', 'none');
      c.cachedPill.hidden = true;
      return;
    }

    var lv = LEVELS[data.level];

    c.el.setAttribute('data-level', data.level);
    c.el.setAttribute('data-rank', String(lv.rank));   // 决定卡片排序，异常置顶

    c.pm25.textContent = data.pm25 === null ? '—' : String(data.pm25);
    c.co2.textContent  = data.co2  === null ? '—' : String(data.co2);

    c.pillIcon.textContent = lv.icon;
    c.pillText.textContent = lv.label;
    c.status.textContent   = lv.label;
    c.crowd.textContent    = data.crowdText;

    c.time.textContent = formatTime(data.time);
    c.time.title = (data.time === undefined || data.time === null) ? '' : String(data.time);

    // 缓存标记：只在本地存档回灌、且尚未收到实时报文时显示
    c.cachedPill.hidden = !data.cached;

    // 处置建议只在结论变化时重建，避免每条报文都动 DOM
    if (c.renderedLevel !== data.level) {
      var frag = document.createDocumentFragment();
      for (var i = 0; i < lv.actions.length; i++) {
        var li = document.createElement('li');
        li.textContent = lv.actions[i];
        frag.appendChild(li);
      }
      c.actionList.textContent = '';
      c.actionList.appendChild(frag);
      c.renderedLevel = data.level;
    }
    c.actionBox.hidden = false;
  }

  /* 全局告警横幅：只要有区域结论不是「正常」就高亮展示 */
  function renderBanner(abnormal) {
    if (!abnormal.length) {
      els.alertBanner.hidden = true;
      els.alertChips.textContent = '';
      return;
    }

    // 横幅整体取最高级别的配色
    els.alertBanner.setAttribute('data-level', abnormal[0].data.level);

    var frag = document.createDocumentFragment();
    for (var i = 0; i < abnormal.length; i++) {
      var li = document.createElement('li');
      li.className = 'alert-chip';
      li.setAttribute('data-level', abnormal[i].data.level);
      li.textContent = abnormal[i].zone.name + ' · ' + LEVELS[abnormal[i].data.level].label;
      frag.appendChild(li);
    }
    els.alertChips.textContent = '';
    els.alertChips.appendChild(frag);
    els.alertBanner.hidden = false;
  }

  /* 页脚说明：只在「画面上的数据不是实时来的」或「刚清空过」时出现，
     两种情况合并成一条，避免和小字链路自检抢位置 */
  function footNote() {
    var cachedN = Store.cachedCount();

    if (restoreInfo && cachedN) {
      return '已恢复 ' + restoreInfo.count + ' 条本地历史 · ' + cachedN + ' 个区域为缓存读数' +
             (restoreInfo.lastStamp ? '（' + restoreInfo.lastStamp + '）' : '') +
             ' · 收到实时报文后自动转为实时';
    }

    if (clearNote && Store.counters.messages === 0) return clearNote;

    return '';
  }

  /* 当前优先关注：与 Web 大屏同源同规则，只是手机上压成一条横幅。
     文案与另外三端逐字一致，方便对照排查。 */
  function renderPriority() {
    var pri = Store.priority;

    // 还没有任何读数：整块不出现，页面顶部只留连接状态
    if (!pri.rows.length) {
      els.priorityBanner.hidden = true;
      return;
    }

    var win = pri.winner;
    els.priorityBanner.hidden = false;
    els.priorityBanner.dataset.focus = win ? 'yes' : 'no';

    if (!win) {
      els.priorityTag.textContent = '持续风险';
      els.priorityZone.textContent = '暂无优先关注';
      els.priorityTotalRow.hidden = true;
      els.prioritySplit.textContent = '各区域环境正常、人流稀疏，总分均为 0';
      els.priorityReason.hidden = true;
      els.priorityVerdict.hidden = true;
      return;
    }

    els.priorityTag.textContent = '当前优先关注';
    els.priorityZone.textContent = win.name;
    els.priorityTotalRow.hidden = false;
    els.priorityTotal.textContent = String(win.total);
    els.prioritySplit.textContent = '环境异常分 ' + win.env + ' · 人流分 ' + win.crowd;
    els.priorityReason.textContent = win.reason;
    els.priorityReason.hidden = false;
    els.priorityVerdict.textContent = win.verdict || '';
    els.priorityVerdict.hidden = false;
  }

  function renderAll() {
    var abnormal = [];
    var reportedCount = 0;

    for (var i = 0; i < ZONES.length; i++) {
      var zone = ZONES[i];
      var data = Store.zones[zone.id] || null;

      renderCard(zone, data);

      if (data) {
        reportedCount++;
        if (data.level !== 'good') {
          abnormal.push({ zone: zone, data: data, rank: LEVELS[data.level].rank });
        }
      }
    }

    // 异常区域按严重度倒序，最严重的排在最前
    abnormal.sort(function (a, b) { return b.rank - a.rank; });

    renderPriority();
    renderBanner(abnormal);
    els.allClear.hidden   = !(reportedCount > 0 && abnormal.length === 0);
    els.emptyHint.hidden  = reportedCount > 0;

    els.msgCount.textContent    = String(Store.counters.messages);
    els.rejectCount.textContent = String(Store.counters.rejected);

    var note = footNote();
    els.restoreNote.textContent = note;
    els.restoreNote.hidden = !note;
  }

  /* 顶部连接状态 */
  function setConn(state, text, detail) {
    els.appBar.setAttribute('data-conn', state);
    els.connText.textContent = text;
    if (detail !== undefined) els.connDetail.textContent = detail;
  }

  /* ============================================================
     6. 本地持久化：读写与恢复
     ============================================================ */

  /* 无痕模式 / 禁用站点数据 / file:// 下，第一次碰 localStorage 就会抛错。
     先探一次，探不通就整体降级成「只留内存」，页面其余功能照常 */
  var storageOk = (function () {
    try {
      var probe = '__airguard_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      console.warn('[AirGuard] 本地存储不可用，历史记录只保留在内存中：', e);
      return false;
    }
  })();

  var saveTimer = null;

  function loadHistory() {
    if (!storageOk) return [];

    var raw;
    try {
      raw = window.localStorage.getItem(HISTORY.key);
    } catch (e) {
      return [];
    }
    if (!raw) return [];

    try {
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];

      var out = [];
      for (var i = 0; i < arr.length; i++) {
        if (isValidRecord(arr[i])) out.push(arr[i]);
      }
      return trimRecords(out, HISTORY.limit);
    } catch (e) {
      console.warn('[AirGuard] 本地历史不是合法 JSON，已忽略：', e);
      return [];
    }
  }

  /* 写盘前再压一次上限：页面连收几小时报文的话，
     内存与存档都会一路涨上去，不能只在启动读回时筛 */
  function saveHistory() {
    if (!storageOk) return false;
    trimRecords(historyRecords, HISTORY.limit);

    var text = JSON.stringify(historyRecords);
    try {
      window.localStorage.setItem(HISTORY.key, text);
      return true;
    } catch (e) {
      // 配额溢出：丢掉最旧的一半再试一次，尽量把新的留下
      try {
        historyRecords.splice(0, Math.ceil(historyRecords.length / 2));
        window.localStorage.setItem(HISTORY.key, JSON.stringify(historyRecords));
        return true;
      } catch (e2) {
        console.warn('[AirGuard] 本地历史写入失败：', e2);
        return false;
      }
    }
  }

  function scheduleSave() {
    if (!storageOk) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(flushSave, HISTORY.debounceMs);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    saveHistory();
  }

  /* 关页面 / 切到后台前补一次写入，保证不丢最后几百毫秒内的数据。
     pagehide 覆盖切后台与关标签，beforeunload 兜桌面浏览器的刷新 */
  window.addEventListener('pagehide', flushSave);
  window.addEventListener('beforeunload', flushSave);

  /* 读回本地历史 → 每个区域挑最后一条有读数的记录还原成卡片。
     复用 Store.ingest 走同一条渲染链路（渲染逻辑只有一份），
     但打上 cached 标记：不计消息数、不进历史、不生成新告警 */
  function restoreHistory() {
    var arr = loadHistory();

    historyRecords.length = 0;
    if (!arr.length) return;

    for (var i = 0; i < arr.length; i++) historyRecords.push(arr[i]);

    var latest = {};
    for (var j = 0; j < arr.length; j++) {
      // 读数全空的条目（例如只有时间戳的占位）不能拿去覆盖卡片，
      // 否则会把上次的真实读数擦成一片「—」，还会白记一次串区拦截
      if (arr[j].pm25 === null && arr[j].co2 === null) continue;
      latest[arr[j].zone] = j;
    }

    var restored = 0;
    var newest = null;

    for (var id in latest) {
      if (!Object.prototype.hasOwnProperty.call(latest, id)) continue;

      var rec = arr[latest[id]];
      if (!Store.ingest('Airguard/' + id + '/data', JSON.stringify(rec), { cached: true })) continue;

      restored++;
      var d = toDate(rec.time);
      if (d && (!newest || d > newest)) newest = d;
    }

    if (restored) {
      restoreInfo = {
        count: historyRecords.length,
        cachedCount: restored,
        lastStamp: newest ? fmtStampShort(newest) : ''
      };
    }
  }

  /* 清空本地记录：存储与内存一起抹掉，并给一次回执。
     MQTT 连接、后续报文与告警完全不受影响 */
  function clearHistory() {
    if (!window.confirm('确定清空本地历史记录？\n\n' +
        '将删除已保存的 ' + historyRecords.length + ' 条记录，清除后无法恢复。\n' +
        'MQTT 实时接收与告警不受影响。')) return;

    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    historyRecords.length = 0;      // 原地清空，保住外部持有的引用
    restoreInfo = null;

    if (storageOk) {
      try {
        window.localStorage.removeItem(HISTORY.key);
      } catch (e) {
        console.warn('[AirGuard] 本地历史删除失败：', e);
      }
    }

    clearNote = '本地记录已清空';
    Store.clearAll();               // 内部 notify → renderAll，回执随之显示
  }

  /* ============================================================
     7. MQTT 接入
     ============================================================ */

  var Mqtt = {
    client: null,

    start: function () {
      if (typeof window.mqtt === 'undefined') {
        setConn('error', '库未加载', 'mqtt.js 未成功加载，请检查网络或 CDN 是否可达');
        return;
      }

      setConn('connecting', '连接中', '正在连接 ' + CONFIG.mqtt.url + ' …');

      var client = window.mqtt.connect(CONFIG.mqtt.url, CONFIG.mqtt.options);
      this.client = client;

      client.on('connect', function () {
        setConn('connected', 'MQTT 已连接',
          '已连接 ' + CONFIG.mqtt.url + ' · 已订阅 ' + CONFIG.mqtt.topic + ' · 等待报文…');

        client.subscribe(CONFIG.mqtt.topic, { qos: CONFIG.mqtt.qos }, function (err) {
          if (err) {
            setConn('error', '订阅失败',
              '订阅 ' + CONFIG.mqtt.topic + ' 失败：' + (err && err.message ? err.message : err));
          }
        });
      });

      client.on('message', function (topic, payload) {
        Store.ingest(topic, payload.toString());
      });

      client.on('reconnect', function () {
        setConn('connecting', '重连中', '连接中断，正在重连 ' + CONFIG.mqtt.url + ' …');
      });

      client.on('close', function () {
        setConn('error', '连接已断开', '与 Broker 的连接已断开，将每 3 秒自动重连…');
      });

      client.on('error', function (err) {
        setConn('error', '连接异常',
          'MQTT 错误：' + (err && err.message ? err.message : err));
      });
    }
  };

  /* ============================================================
     8. 启动
     ============================================================ */

  function init() {
    cacheEls();
    mountCards();
    Store.subscribe(renderAll);
    restoreHistory();     // 先回灌本地历史，首屏直接就是上次看到的样子
    renderAll();          // 无存档时三张卡片为空，等待 MQTT 推送
    Mqtt.start();

    var clearBtn = document.getElementById('clearHistory');
    if (clearBtn) clearBtn.addEventListener('click', clearHistory);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* 历史记录数组本体挂到 window：与内部数组是同一个引用，
     便于调试台与自动化验证直接读取 */
  window.historyRecords = historyRecords;

  // 暴露给调试台 / 自动化验证使用
  window.AirGuardMobile = {
    config: CONFIG,
    zones: ZONES,
    levels: LEVELS,
    crowdLevels: CROWD_LEVELS,
    store: Store,
    history: {
      key: HISTORY.key,
      limit: HISTORY.limit,
      available: storageOk,
      records: historyRecords,        // 同一个引用，不复制
      info: function () { return restoreInfo; },
      load: loadHistory,
      save: saveHistory,
      restore: restoreHistory,
      clear: clearHistory
    },
    subscribe: function (fn) { Store.subscribe(fn); },
    getSnapshot: function () { return JSON.parse(JSON.stringify(Store.zones)); },
    /* 持续风险与优先关注：打分结果与感知记录，供联调与自动化测试使用。
       注意这是内存态，不落盘，刷新即重来（见 4b 节说明）。 */
    priority: {
      source: PRIORITY_SOURCE,
      envSingle: PRIORITY_ENV_SINGLE,
      envStreak: PRIORITY_ENV_STREAK,
      rows: function () { return Store.priority.rows; },
      winner: function () { return Store.priority.winner; },
      streaks: function () { return Store.streaks; },
      streakStart: function () { return Store.streakStart; },
      spanText: spanText,
      perception: function () { return Store.perception; }
    },
    pushReading: function (topic, payload) {
      Store.ingest(topic, typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
  };

})();
