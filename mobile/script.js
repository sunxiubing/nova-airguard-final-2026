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
      /* D3 干预广播：Airguard/+/data 只匹配「第三段是 data」的主题，
         Airguard/intervention/zone-n 的第三段是区域名，两者不会互相误收 */
      interventionTopic: 'Airguard/intervention/+',
      interventionPrefix: 'Airguard/intervention/',
      qos: 0,
      options: {
        clientId: 'airguard-mobile-' + Math.random().toString(16).slice(2, 10),
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 3000,           // 断线后每 3 秒自动重连
        keepalive: 30
      }
    },
    maxPerception: 30,      // 感知记录在内存里保留的条数（不落盘，仅用于本次会话）
    maxEvents: 50           // D3 事件流水在内存里保留的条数
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

  /* ------------------------------------------------------------
     D3 干预—验证—恢复：事件状态机常量
     与 Web 大屏 / 3D 沙盘 / 小程序逐字一致，四端各存一份实现，
     靠同一套规则与 MQTT 广播收敛，任何一端都不许自行改口径：

       OPEN 待处理 --提交干预动作--> HANDLING 处理中 --1 组新数据达标--> RECOVERED 已恢复
                                     └--连续 2 组数据恶化--> 回退 OPEN

     · 恢复只能由后续新监测数据自动判定，点按钮绝不能直接置 RECOVERED
     · OPEN 不能直接跳 RECOVERED，必须经过 HANDLING + 两组验证数据
     · 低可信度数据不能促成恢复，标记人工复核，状态保持 HANDLING
     · 事件已 RECOVERED 之后，迟到 / 重复消息不能把状态改回去
     ------------------------------------------------------------ */
  var EV_OPEN = 'OPEN', EV_HANDLING = 'HANDLING', EV_RECOVERED = 'RECOVERED';
    var EV_RELAPSE_SAMPLES = 2;     // 干预后连续这么多组数据严重度高于干预时 → 回退 OPEN
  var EV_CONFIDENCE_FLOOR = 0.6;  // 低于此值视为低可信度感知数据
  var EV_DEDUPE_MAX = 500;        // 去重键保留上限（超出丢最旧的）
  var EV_LOG_MAX = 40;            // 单个事件最多留存的原始消息条数

  /* 干预动作候选：按异常类型分组，卡片里可多选 */
  var EV_ACTIONS = {
    warning:  ['开启低档位新风', '广播提醒开窗通风', '安排教室巡检'],
    critical: ['全开新风+喷雾降尘', '关闭外窗', '暂停大型聚集活动'],
    serious:  ['开启教室新风换气机组', '课间开窗提醒', '延长排风扇工作时间'],
    crowd2:   ['安排人员走廊分流', '大屏错峰下课提示', '开放备用通道'],
    crowd3:   ['区域入口限流', '广播引导疏散', '上报值班老师']
  };

  /* 状态在界面上的说法，四端统一 */
  var EV_LABEL = {
    OPEN: 'OPEN 待处理',
    HANDLING: 'HANDLING 处理中',
    RECOVERED: 'RECOVERED 已恢复'
  };

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
    'zone-n': 'zone-n', 'n': 'zone-n', 'north': 'zone-n', '宿舍区': 'zone-n', '宿舍': 'zone-n', 'dorm': 'zone-n',
    'zone-s': 'zone-s', 's': 'zone-s', 'south': 'zone-s', '教学区': 'zone-s', '教学': 'zone-s', 'teach': 'zone-s',
    'zone-w': 'zone-w', 'w': 'zone-w', 'west': 'zone-w', '食堂区': 'zone-w', '食堂': 'zone-w', 'canteen': 'zone-w', 'dining': 'zone-w'
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

  /* 双通道区域校验：主题段与报文 zoneId 必须指向同一区域。
     任一路写了无法识别的区域、或两路互相矛盾，整条报文一律拒收；
     主题认不出区域时绝不回退到报文 zoneId —— 那正是串区报文的典型形态
     （主题 Airguard/zone-m/data + 报文 zoneId=zone-w）。
     四端同一口径：web / 手机端 / 小程序 / 3D 沙盘。 */
  function resolveZone(topic, payload) {
    var fromTopic = zoneFromTopic(topic);
    var rawPayloadZone = field(payload, ['zoneid', 'zone_id', 'zone', 'areaid', 'area']);
    var fromPayload = deriveZoneId(rawPayloadZone);
    var payloadZoneGiven = rawPayloadZone !== undefined && rawPayloadZone !== null &&
                           String(rawPayloadZone).trim() !== '';

    if (!fromTopic) {
      return { error: 'topic-zone', detail: '主题「' + topic + '」里没有可识别的区域段' };
    }
    if (payloadZoneGiven) {
      if (!fromPayload) {
        return { error: 'payload-zone', detail: '报文 zoneId「' + rawPayloadZone + '」不是已知区域' };
      }
      if (fromTopic !== fromPayload) {
        return { error: 'mismatch', detail: '主题指向 ' + fromTopic + '，报文 zoneId 却是 ' + fromPayload };
      }
    }
    return { zoneId: fromTopic };
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
     3-b. 会话内记录：纯函数部分
     MQTT 收到一条 → 进内存 historyRecords；四端一律不落盘，
     刷新即全部清零，画面由本次会话新收到的报文重建。
     只负责记录，不参与任何结论判定，原有 MQTT / 告警链路不受影响
     ============================================================ */

  var RECORD_LIMIT = 5000;   // 内存里最多保留 5000 条，超出丢最旧的

  /* D3 事件流水（含当前事件状态）同样只在内存里，刷新即回到初始态 */

  /* 内存里的历史记录。始终原地增删，绝不整体重新赋值，
     否则外部（调试台 / 自动化验证）提前拿到的引用会指向旧数组 */
  var historyRecords = [];

  /* 清空后的一次性回执，下一条实时报文到达即让位 */
  var clearNote = null;
  /* 感知记录编号：zoneId → 该区域本次会话已产生的条数（imageId 里的序号） */
  var perceptionSeq = {};

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }

  /* 各种时间写法归一成 Date：数字 / 数字串按秒或毫秒，带日期的按本地时区，
     纯时间按今天，其余交给 Date 解析。
     与另外三端同一口径——四端必须对同一个时间写法得到同一个时刻，
     否则「乱序」判定在四端会得出不同结论。 */
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

    /* 采集端把时间戳 stringify 成字符串（"1791091745" / "1791091745000"）：
       与数字同等对待，不认这种写法乱序判定会悄悄退回「谁后到谁更新」 */
    if (/^\d{10}$|^\d{13}$/.test(s)) {
      var n = Number(s);
      var ds = new Date(n < 1e12 ? n * 1000 : n);
      return isNaN(ds.getTime()) ? null : ds;
    }

    /* 带日期的时间：手写解析，不依赖各内核 Date 解析的宽松程度——
       "2026-10-4 13:28:00"（不补零）在部分内核上解析不出来，
       直接落回「接收时刻」，乱序判定同样会失效 */
    var fm = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (fm) {
      var df = new Date(Number(fm[1]), Number(fm[2]) - 1, Number(fm[3]),
                        Number(fm[4]), Number(fm[5]), Number(fm[6] || 0));
      return isNaN(df.getTime()) ? null : df;
    }

    var t = s.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
    if (t) {
      var now = new Date();
      return new Date(now.getFullYear(), now.getMonth(), now.getDate(),
        Number(t[1]), Number(t[2]), Number(t[3] || 0));
    }

    var ts = Date.parse(s);
    if (isNaN(ts)) ts = Date.parse(s.replace(/-/g, '/'));   // 兼容部分内核的解析差异
    return isNaN(ts) ? null : new Date(ts);
  }

  function fmtStampFull(value) {
    var d = toDate(value);
    if (!d) return '';
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
           pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* 实时报文 → 记录条目。字段顺序与任务书 CSV 表头一致：
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
    counters: { messages: 0, rejected: 0, duplicates: 0 },
    listeners: [],
    streaks: {},                                // zoneId → 末尾连续异常条数
    streakStart: {},                            // zoneId → 本轮连续异常首条记录的时刻（ms）
    perception: [],                             // 感知记录，最新在前，上限 CONFIG.maxPerception
    priority: { rows: [], winner: null },       // 优先关注打分结果
    events: [],                                 // D3 事件流水，最新在前
    activeEvents: {},                           // zoneId → 当前事件（含已恢复的最后一条）

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

      /* 先造出来，过了下面「重复」与「乱序」两道关才入住 this.zones */
      var prevReading = this.zones[zoneId];
      var reading = {
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
        // 归一化的完整时刻，事件字段与去重指纹都用它（同一个时间写法在四端必须得到同一个字符串）
        timeFull: fmtStampFull(time) || fmtStampFull(Date.now()),
        lowConfidence: isLowConfidence(payload),   // D3：低可信度数据不能促成恢复
        cached: cached,       // 一旦来了实时报文，下一次就自动脱掉缓存标记
        duplicate: false      // D3：被去重拦下的报文，只回执不入库
      };

      /* ---- D3 消息健壮性：重复消息只生效一次 ----
         判据优先 message_id，没有才用 zoneId + 时间 + 载荷指纹（event_id 不参与）。
         被拦下的报文不改状态、不计消息数、不建事件、不进历史日志、不生成感知记录。
         缓存回灌不是「刚收到的报文」，不参与去重。 */
      if (!cached && isDuplicate(dedupeKey(payload, zoneId, reading))) {
        reading.duplicate = true;
        this.counters.duplicates++;
        console.warn('[AirGuard] 重复报文已忽略：' + zoneId + ' @ ' + reading.timeFull);
        return false;
      }

      /* ---- D3 消息健壮性：乱序消息不覆盖更新的实时状态 ----
         报文时间早于本会话已入住的读数，就是「后到达的旧消息」。它照样算收到、
         照样进历史与感知记录，但不回写实时读数、不动连续异常计数、不进趋势图，
         也不能凭一个更早的时间去开新事件 —— 那同样是旧消息覆盖新状态。
         跨会话不比较：存档读数标着 cached，对方时钟被重置过时仍以实时报文为准。 */
      if (!cached && prevReading && !prevReading.cached && reading.ts < prevReading.ts) {
        reading.outOfOrder = true;
        clearNote = null;
        this.counters.messages++;
        addPerception(reading);
        historyRecords.push(toRecord(reading));
        trimRecords(historyRecords, RECORD_LIMIT);
        /* 只往已有事件的日志里补一笔；没有事件就不建 —— 旧消息不产生新状态 */
        if (this.activeEvents[zoneId]) this.applyEvent(reading);
        this.notify();
        return true;
      }

      this.zones[zoneId] = reading;

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
      trimRecords(historyRecords, RECORD_LIMIT);

      /* D3：每条通过去重的实时报文推进一次事件状态机 */
      this.applyEvent(reading);

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

    /* ---------------------------------------------------------------
     * D3 事件状态机。规则层在 4a 节，这里只负责推进，状态只活在内存里。
     * 唯一入口是 applyEvent：不管是从 MQTT 来的还是从卡片按钮来的，
     * 状态的每一次变化都要经过它，别的函数不许直接写 state 字段。
     * ------------------------------------------------------------- */

    /** 事件日志：每条影响过判断的报文留一行，便于事后对账 */
    pushLog: function (ev, reading, note) {
      ev.log.push({
        time: reading.timeFull || reading.time || '',
        ts: reading.ts,
        level: reading.level || '',
        levelLabel: reading.level ? LEVELS[reading.level].label : '',
        crowdLevel: reading.crowdLevel === undefined ? null : reading.crowdLevel,
        note: note
      });
      if (ev.log.length > EV_LOG_MAX) ev.log.shift();
    },

    createEvent: function (reading) {
      var rank = LEVELS[reading.level].rank;
      var crowd = crowdScore(reading.crowdLevel);
      var name = (findZoneName(reading.zoneId)) || reading.zoneId;
      var ev = {
        event_id: 'evt-' + reading.zoneId + '-' + (++eventSeq) + '-' + reading.ts,
        zoneId: reading.zoneId,
        zoneName: name,
        startedAt: reading.timeFull,      // 事件开始时间
        startedTs: reading.ts,
        type: eventTypeOf(rank, crowd),   // 异常类型
        priorityReason: eventReason(reading),   // 优先关注理由
        userActions: [],                  // 用户干预动作记录
        verifySamples: [],                // 干预后多组验证数据集
        state: EV_OPEN,                   // 当前事件状态
        interventionAt: null,             // 干预提交时刻
        severityAtIntervention: null,
        recoveredAt: null,                // 恢复时间
        outcome: '待处理',                // 最终结果
        manualReview: false,              // 低可信度数据触发的「人工复核」标记
        severity: severityOf(rank, crowd),
        actionKey: eventActionKey(reading),
        lastTs: reading.ts,               // 已处理到的最新报文时刻，用于识别乱序 / 迟到
        relapseSamples: 0,
        log: []
      };
      this.pushLog(ev, reading, '监测捕获异常，事件建立');

      this.events.unshift(ev);
      if (this.events.length > CONFIG.maxEvents) this.events.length = CONFIG.maxEvents;
      this.activeEvents[reading.zoneId] = ev;
      return ev;
    },

    /** 事件机唯一入口。每条通过去重的实时报文进来一次。
     *  乱序 / 迟到（时间戳早于本事件已处理的最后一条）不参与状态判断，只入日志 */
    applyEvent: function (reading) {
      var rank = LEVELS[reading.level].rank;
      var crowd = crowdScore(reading.crowdLevel);
      var ev = this.activeEvents[reading.zoneId] || null;

      /* ---- 无事件：只有确实异常才建 ---- */
      if (!ev) {
        if (!isAbnormal(reading.level, crowd)) return null;
        return this.createEvent(reading);
      }

      /* ---- 乱序 / 迟到：旧消息不能覆盖更新后的最新状态 ---- */
      if (reading.ts < ev.lastTs) {
        this.pushLog(ev, reading, '迟到/乱序消息，仅存档，不参与状态判断');
        return ev;
      }

      /* 水位线对每条已通过前面检查的报文都推进，包括下面「已恢复」分支里的存档。
         漏掉存档那一步，恢复之后到达的旧异常就会因为「比恢复时刻新」而开出一个
         带着旧时间戳的新事件 —— 那正是「旧消息覆盖新状态」 */
      ev.lastTs = reading.ts;

      /* ---- 事件已恢复：迟到、重复消息都不回滚状态 ---- */
      if (ev.state === EV_RECOVERED) {
        if (isAbnormal(reading.level, crowd)) {
          /* 恢复之后又出现新的异常 —— 这是新事件，不是旧事件回滚 */
          return this.createEvent(reading);
        }
        this.pushLog(ev, reading, '事件已恢复，后续消息仅存档');
        return ev;
      }


      /* ---- OPEN 待处理：数据只刷新严重度与理由，状态不动 ---- */
      if (ev.state === EV_OPEN) {
        ev.severity = severityOf(rank, crowd);
        ev.priorityReason = eventReason(reading);
        ev.actionKey = eventActionKey(reading);
        this.pushLog(ev, reading, '待处理中的数据更新');
        return ev;
      }

      /* ---- HANDLING 处理中：只能由新监测数据判定，按钮到不了这里 ---- */

      /* 低可信度感知数据不能促成恢复。若这条本可判恢复，标记人工复核并作废这条数据，
         状态保持 HANDLING —— 宁可不恢复，也不能让一条不可信的数据把事件关掉 */
      if (reading.lowConfidence) {
        if (isRecoveredEnv(reading.level, crowd)) {
          ev.manualReview = true;
          ev.verifySamples.length = 0;
          ev.outcome = '低可信度数据，已标记人工复核';
        }
        this.pushLog(ev, reading, '低可信度数据，不参与恢复判定');
        return ev;
      }

      if (isRecoveredEnv(reading.level, crowd)) {
        ev.manualReview = false;
        ev.relapseSamples = 0;
        ev.verifySamples.push({
          time: reading.timeFull,
          pm25: reading.pm25,
          co2: reading.co2,
          crowdLevel: reading.crowdLevel,
          level: reading.level
        });
        /* 干预后的验证数据仍然留档（事件字段要求有「干预后验证数据集」），
           但恢复不设门槛：第一条达标数据就判定恢复，不再累计条数 */
        ev.state = EV_RECOVERED;
        ev.recoveredAt = reading.timeFull;
        ev.outcome = '已恢复';
        this.pushLog(ev, reading, '收到正常监测数据，自动判定恢复');
        return ev;
      }

      /* 不达标：严重度高于干预那一刻才算恶化 */
      ev.verifySamples.length = 0;
      if (severityOf(rank, crowd) > ev.severityAtIntervention) {
        ev.relapseSamples += 1;
        if (ev.relapseSamples >= EV_RELAPSE_SAMPLES) {
          ev.state = EV_OPEN;
          ev.relapseSamples = 0;
          ev.outcome = '干预无效，回退待处理';
          ev.severity = severityOf(rank, crowd);
          ev.priorityReason = eventReason(reading);
          ev.actionKey = eventActionKey(reading);
          this.pushLog(ev, reading, '连续 ' + EV_RELAPSE_SAMPLES + ' 组数据恶化，回退 OPEN');
        } else {
          ev.outcome = '仍需关注';
          this.pushLog(ev, reading, '数据恶化 ' + ev.relapseSamples + '/' + EV_RELAPSE_SAMPLES);
        }
      } else {
        ev.relapseSamples = 0;
        ev.outcome = '仍需关注';
        this.pushLog(ev, reading, '数据未达标，继续观察');
      }
      return ev;
    },

    /** 提交干预动作。只有 OPEN 能提交；这里绝不会把状态置成 RECOVERED ——
     *  恢复只能由后续新监测数据自动判定。返回事件对象表示成功，null 表示被拒 */
    intervene: function (zoneId, actions, meta) {
      var ev = this.activeEvents[zoneId];
      if (!ev || ev.state !== EV_OPEN) return null;

      var list = [];
      for (var i = 0; i < (actions || []).length; i++) {
        var a = actions[i];
        if (typeof a === 'string' && a.trim() && list.indexOf(a) < 0) list.push(a);
      }
      if (!list.length) return null;

      meta = meta || {};
      ev.state = EV_HANDLING;
      ev.userActions.push({
        actions: list,
        at: meta.at || fmtStampFull(Date.now()),
        actor: meta.actor || 'mobile'
      });
      ev.interventionAt = ev.userActions[ev.userActions.length - 1].at;
      ev.severityAtIntervention = ev.severity;
      ev.verifySamples.length = 0;
      ev.relapseSamples = 0;
      ev.manualReview = false;
      ev.outcome = '干预已提交，等待新监测数据验证';
      this.pushLog(ev, { timeFull: ev.interventionAt, ts: Date.now(), level: '', crowdLevel: null },
        '管理员提交干预：' + list.join(' / '));
      this.notify();
      return ev;
    },

    /** 收到别端广播来的干预（Web 大屏 / 3D 沙盘 / 小程序）。
     *  event_id 对得上、且本端该区域事件正处于 OPEN 才应用；其余一律忽略。
     *  同一条干预重复到达是幂等的（第二次 event 已经不是 OPEN，直接被挡） */
    receiveIntervention: function (msg) {
      if (!msg || msg.type !== 'intervention') return null;
      var ev = this.activeEvents[msg.zoneId];
      if (!ev || ev.state !== EV_OPEN) return null;
      if (msg.event_id && msg.event_id !== ev.event_id) return null;
      return this.intervene(msg.zoneId, msg.actions, { actor: msg.actor, at: msg.at });
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
      /* D3：事件、当前事件指向、去重表一起归零，回到「等第一条报文」的初始态。
         去重表也要清 —— 否则清空后重放同一批报文会被当成重复直接丢掉 */
      this.events.length = 0;
      this.activeEvents = {};
      eventSeq = 0;
      seenKeys.length = 0;
      seenSet = {};
      this.counters.messages = 0;
      this.counters.rejected = 0;
      this.counters.duplicates = 0;
      this.notify();
    }
  };

  /* ============================================================
     4a. D3 干预—验证—恢复：判定函数与消息去重
     四端逐字同源的规则层，Store 的状态机只调用这里，不自己另算一套
     ============================================================ */

  /** FNV-1a 32 位哈希。给没有 message_id 的报文算载荷指纹用 ——
   *  比 JSON.stringify 短且稳定，同一份载荷在任何一端都得到同一个值 */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h.toString(16);
  }

  /* 严重度：环境等级优先，人流次之。等级差一级压过人流差三级，
     这样「重度污染 + 人流稀疏」永远排在「轻度污染 + 严重拥挤」前面 */
  function severityOf(levelRank, crowd) { return levelRank * 4 + crowd; }

  /* 异常：环境非正常，或人流达到拥挤及以上（2 / 3 档） */
  function isAbnormal(level, crowd) { return level !== 'good' || crowd >= 2; }

  /* 恢复阈值：环境回到正常，且人流不再是拥挤 */
  function isRecoveredEnv(level, crowd) { return level === 'good' && crowd <= 1; }

  /* 异常类型：环境等级与人流等级谁高算谁，平手时算环境异常 */
  function eventTypeOf(levelRank, crowd) {
    return levelRank >= crowd ? '环境异常' : '人流拥挤';
  }

  /* 低可信度：报文带了 confidence 并且低于阈值。
     字段缺失＝常规感知数据（可信），兼容现状 —— 现有采集端不发这个字段 */
  function isLowConfidence(payload) {
    var c = toNum(field(payload, ['confidence', 'conf', 'credibility']));
    return c !== null && c < EV_CONFIDENCE_FLOOR;
  }

  /* 优先关注理由：把「为什么是它」写成人话存进事件字段 */
  function eventReason(reading) {
    return 'PM2.5 ' + reading.pm25 + ' μg/m³ / CO₂ ' + reading.co2 + ' ppm（' +
           LEVELS[reading.level].label + '）+ 人流' +
           CROWD_LEVELS[crowdScore(reading.crowdLevel)] + ' ' + reading.crowdLevel +
           ' 级 → 严重度 ' + severityOf(LEVELS[reading.level].rank, crowdScore(reading.crowdLevel));
  }

  /* 这条读数该配哪一组干预动作（异常类型决定组别） */
  function eventActionKey(reading) {
    if (eventTypeOf(LEVELS[reading.level].rank, crowdScore(reading.crowdLevel)) === '人流拥挤') {
      return 'crowd' + clamp(Math.round(reading.crowdLevel), 2, 3);
    }
    return reading.level;
  }

  /* 消息去重键。优先报文自带的 message_id；没有才用 zoneId + 时间 + 载荷指纹。
     event_id 绝不参与去重 —— 它标记的是同一个「持续事件」，跨多条消息保持不变，
     拿它去重会把同一事件后续的验证数据全部误杀 */
  function dedupeKey(payload, zoneId, reading) {
    var mid = field(payload, ['message_id', 'messageid', 'msgid', 'msg_id']);
    if (mid !== undefined && mid !== null && String(mid).trim() !== '') {
      return zoneId + '|mid|' + String(mid).trim();
    }
    return zoneId + '|sum|' + fnv1a([
      zoneId, reading.timeFull, reading.pm25, reading.co2, reading.crowdLevel, reading.level
    ].join('|'));
  }

  /* 去重表：数组保序（用来淘汰最旧的键），对象做 O(1) 命中判断 */
  var seenKeys = [];
  var seenSet = {};

  function isDuplicate(key) {
    if (Object.prototype.hasOwnProperty.call(seenSet, key)) return true;
    seenSet[key] = 1;
    seenKeys.push(key);
    if (seenKeys.length > EV_DEDUPE_MAX) delete seenSet[seenKeys.shift()];
    return false;
  }

  /* 事件序号：event_id 里的自增段，恢复存档时按已有的最大值接着往下发 */
  var eventSeq = 0;

  /* 区域名：事件卡片上要显示中文名，而不是 zone-n 这种代号 */
  function findZoneName(zoneId) {
    for (var i = 0; i < ZONES.length; i++) {
      if (ZONES[i].id === zoneId) return ZONES[i].name;
    }
    return '';
  }

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

        // D3 干预—验证—恢复：本区域的告警卡片。干预动作全部在这块里用文字完成，
        // 不画任何图标；状态色由 data-state 控制（红 / 黄 / 绿）
        '<div class="event-box" hidden>' +
          '<div class="event-head">' +
            '<span class="event-state"></span>' +
            '<span class="event-type"></span>' +
          '</div>' +
          '<div class="event-body"></div>' +
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
      eventBox:   el.querySelector('.event-box'),
      eventState: el.querySelector('.event-state'),
      eventType:  el.querySelector('.event-type'),
      eventBody:  el.querySelector('.event-body'),
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
      bindCardEvents(ZONES[i], c);
      frag.appendChild(c.el);
    }
    els.zoneList.appendChild(frag);
  }

  /* 事件卡片里的交互：勾选干预动作、点【执行干预】。
     卡片内容每次报文都会重画，所以监听挂在卡片外壳上（事件委托），
     重画不会把监听一起冲掉 */
  function bindCardEvents(zone, c) {
    c.el.addEventListener('change', function (e) {
      var input = e.target;
      if (!input || input.type !== 'checkbox' || !input.classList.contains('event-check')) return;

      var list = pendingActions[zone.id] || (pendingActions[zone.id] = []);
      var idx = list.indexOf(input.value);
      if (input.checked && idx < 0) list.push(input.value);
      if (!input.checked && idx >= 0) list.splice(idx, 1);

      // 只切换按钮可用性，不重画整个选择器 —— 手指还停在上面时重建 DOM 会打断勾选
      var btn = c.el.querySelector('.event-submit');
      if (btn) btn.disabled = list.length === 0;
    });

    c.el.addEventListener('click', function (e) {
      var node = e.target;
      while (node && node !== c.el && !(node.className || '').match(/event-submit/)) node = node.parentNode;
      if (!node || node === c.el) return;
      var ev = submitIntervention(zone.id);
      if (!ev) console.warn('[AirGuard] 干预提交被拒：' + zone.id + ' 当前不是待处理状态');
    });
  }

  /* ------------------------------------------------------------
     D3 事件卡片：每栋楼一条，挂在该楼栋自己的卡片里
     干预动作只在 OPEN 状态下可选可提交；HANDLING 只读，恢复由后续
     监测数据自动判定 —— 卡片上永远不出现「手动恢复」按钮
     ------------------------------------------------------------ */

  /* 已勾选、还没提交的干预动作：zoneId → 动作数组。
     卡片每次报文都会重画，勾选状态必须存在卡片外边，否则每来一条
     数据用户的勾选就被抹一次 */
  var pendingActions = {};

  /* 取宿主卡片上的事件对象（可能不存在） */
  function eventOf(zoneId) { return Store.activeEvents[zoneId] || null; }

  function metaRow(dt, dd) {
    var wrap = document.createElement('div');
    var t = document.createElement('dt');
    var d = document.createElement('dd');
    t.textContent = dt;
    d.textContent = dd;
    wrap.appendChild(t);
    wrap.appendChild(d);
    return wrap;
  }

  /* 重建一个区域的事件卡片内容。只在事件存在时显示 */
  function renderEventBox(zone, c) {
    var ev = eventOf(zone.id);
    var box = c.eventBox;

    if (!ev) {
      box.hidden = true;
      box.removeAttribute('data-state');
      c.eventState.textContent = '';
      c.eventType.textContent = '';
      c.eventBody.textContent = '';
      return;
    }

    var z = Store.zones[zone.id] || null;

    box.hidden = false;
    box.setAttribute('data-state', ev.state);          // OPEN 红 / HANDLING 黄 / RECOVERED 绿
    c.eventState.textContent = EV_LABEL[ev.state];
    c.eventType.textContent = ev.type;
    c.eventBody.textContent = '';                      // 就地清空，重建下面的内容

    /* 实时监测数据：卡片要能就地看到「现在是什么数」，不用回头看上面的指标 */
    var live = document.createElement('p');
    live.className = 'event-live';
    live.textContent = z
      ? 'PM2.5 ' + (z.pm25 === null ? '—' : z.pm25) + ' μg/m³ · CO₂ ' +
        (z.co2 === null ? '—' : z.co2) + ' ppm · 人流' + z.crowdText +
        ' · ' + LEVELS[z.level].label + ' · ' + fmtStampFull(z.time)
      : '等待 ' + zone.id + ' 的读数…';
    c.eventBody.appendChild(live);

    if (ev.state === EV_OPEN) {
      /* ---- OPEN 待处理：唯一可交互的状态 ---- */
      var meta = document.createElement('dl');
      meta.className = 'event-meta';
      meta.appendChild(metaRow('异常类型', ev.type));
      meta.appendChild(metaRow('事件开始', ev.startedAt));
      meta.appendChild(metaRow('优先关注理由', ev.priorityReason));
      c.eventBody.appendChild(meta);

      var list = EV_ACTIONS[ev.actionKey] || [];
      var picked = pendingActions[ev.zoneId] || (pendingActions[ev.zoneId] = []);

      var fs = document.createElement('fieldset');
      fs.className = 'event-actions';
      var lg = document.createElement('legend');
      lg.textContent = '选择干预动作（可多选多条）';
      fs.appendChild(lg);

      for (var i = 0; i < list.length; i++) {
        var lab = document.createElement('label');
        lab.className = 'event-action';
        var box2 = document.createElement('input');
        box2.type = 'checkbox';
        box2.className = 'event-check';
        box2.value = list[i];
        box2.checked = picked.indexOf(list[i]) >= 0;
        var span = document.createElement('span');
        span.textContent = list[i];
        lab.appendChild(box2);
        lab.appendChild(span);
        fs.appendChild(lab);
      }
      c.eventBody.appendChild(fs);

      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'event-submit';
      btn.textContent = '执行干预';
      btn.disabled = picked.length === 0;             // 一条都没勾就不给点
      c.eventBody.appendChild(btn);
      return;
    }

    if (ev.state === EV_HANDLING) {
      /* ---- HANDLING 处理中：只读。页面上没有手动恢复入口 ---- */
      var done = document.createElement('div');
      done.className = 'event-done';
      var h = document.createElement('h4');
      h.textContent = '已执行干预动作';
      done.appendChild(h);
      for (var j = 0; j < ev.userActions.length; j++) {
        var u = ev.userActions[j];
        var row = document.createElement('div');
        row.className = 'event-done-row';
        var t1 = document.createElement('span');
        t1.className = 'event-done-time';
        t1.textContent = u.at;
        var t2 = document.createElement('span');
        t2.className = 'event-done-actor';
        t2.textContent = u.actor;
        var t3 = document.createElement('span');
        t3.className = 'event-done-list';
        t3.textContent = u.actions.join(' / ');
        row.appendChild(t1);
        row.appendChild(t2);
        row.appendChild(t3);
        done.appendChild(row);
      }
      c.eventBody.appendChild(done);

      var hint = document.createElement('p');
      hint.className = 'event-hint';
      hint.textContent = '等待新监测数据自动判定恢复（1 条正常数据即恢复），不可手动恢复。';
      c.eventBody.appendChild(hint);

      var prog = document.createElement('p');
      prog.className = 'event-outcome';
      prog.textContent = ev.outcome + (ev.manualReview ? ' · 已标记人工复核' : '');
      if (ev.manualReview) prog.classList.add('event-review');
      c.eventBody.appendChild(prog);
      return;
    }

    /* ---- RECOVERED 已恢复：告警卡片收尾，只留一条只读回执 ---- */
    var recap = document.createElement('dl');
    recap.className = 'event-meta';
    recap.appendChild(metaRow('恢复时间', ev.recoveredAt || '—'));
    recap.appendChild(metaRow('最终结果', ev.outcome));
    recap.appendChild(metaRow('干预动作', ev.userActions.map(function (u) {
      return u.actions.join(' / ');
    }).join('；') || '—'));
    c.eventBody.appendChild(recap);

    var closed = document.createElement('p');
    closed.className = 'event-hint';
    closed.textContent = '事件已恢复，告警卡片自动关闭。';
    c.eventBody.appendChild(closed);
  }

  /* 提交干预：本端状态机 + 向另外三端广播（四端靠这条广播收敛到同一个状态） */
  function submitIntervention(zoneId) {
    var actions = (pendingActions[zoneId] || []).slice();
    if (!actions.length) return null;

    var ev = Store.intervene(zoneId, actions, { actor: 'mobile' });
    if (ev) {
      pendingActions[zoneId] = [];
      Mqtt.publishIntervention(ev, actions);
      console.info('[AirGuard] 已提交干预：' + zoneId + ' → ' + actions.join(' / '));
    }
    return ev;
  }

  /* 更新单张卡片：只改文本节点，不动 DOM 结构 */
  function renderCard(zone, data) {
    var c = cards[zone.id];
    if (!c) return;

    // D3：事件卡片与有没有实时读数无关 —— 刷新后即使还没有新报文，
    // 「处理中」的事件也必须照旧显示
    renderEventBox(zone, c);

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
     6. 清空记录：只清内存
     ============================================================ */

  /* 清空本次会话收到的记录，并给一次回执。
     MQTT 连接、后续报文与告警完全不受影响；四端都不落盘，没有本地存档可删 */
  function clearHistory() {
    if (!window.confirm('确定清空当前记录？\n\n' +
        '将清掉本次会话收到的 ' + historyRecords.length + ' 条记录，清除后无法恢复。\n' +
        'MQTT 实时接收与告警不受影响。')) return;

    historyRecords.length = 0;      // 原地清空，保住外部持有的引用

    clearNote = '记录已清空';
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

        // 两个主题一起订阅：报文流 + 干预广播（别端提交的干预要让本端同时进入「处理中」）
        client.subscribe([CONFIG.mqtt.topic, CONFIG.mqtt.interventionTopic],
          { qos: CONFIG.mqtt.qos }, function (err) {
          if (err) {
            setConn('error', '订阅失败',
              '订阅 ' + CONFIG.mqtt.topic + ' 失败：' + (err && err.message ? err.message : err));
          }
        });
      });

      client.on('message', function (topic, payload) {
        var text = payload.toString();
        // 干预广播与报文流走同一条连接，靠主题前缀分流 ——
        // Airguard/intervention/zone-n 的第 3 段是区域名，不会被 Airguard/+/data 收到
        if (String(topic).indexOf(CONFIG.mqtt.interventionPrefix) === 0) {
          Mqtt.onIntervention(text);
          return;
        }
        Store.ingest(topic, text);
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
    },

    isConnected: function () { return !!(this.client && this.client.connected); },

    /* 收到别端的干预广播：交给状态机判定是否采纳（event_id 对不上、
       本端不是待处理、事件已恢复等情况一律忽略，重复广播是幂等的） */
    onIntervention: function (text) {
      var msg;
      try {
        msg = JSON.parse(text);
      } catch (e) {
        console.warn('[AirGuard] 干预广播不是合法 JSON，已忽略：', text);
        return;
      }
      var ev = Store.receiveIntervention(msg);
      if (ev) {
        console.info('[AirGuard] 已采纳 ' + (msg.actor || '他端') + ' 的干预：' +
                     msg.zoneId + ' → ' + ev.state);
      }
    },

    /* 把本端的干预动作广播出去，让另外三端同时进入「处理中」。
       固定 retain=true：后接入的端（比如刚刷新的大屏）一连上就能拿到当前状态 */
    publishIntervention: function (ev, actions) {
      if (!this.client || !this.client.connected) {
        console.warn('[AirGuard] MQTT 未连接，干预只在本地生效，未广播');
        return false;
      }
      var topic = CONFIG.mqtt.interventionPrefix + ev.zoneId;
      var msg = {
        type: 'intervention',
        event_id: ev.event_id,
        zoneId: ev.zoneId,
        actions: actions,
        at: ev.interventionAt,
        time: fmtStampFull(Date.now()),
        actor: 'mobile'
      };
      this.client.publish(topic, JSON.stringify(msg), { qos: CONFIG.mqtt.qos, retain: true });
      console.info('[AirGuard] 已广播干预：' + topic);
      return true;
    }
  };

  /* ============================================================
     8. 启动
     ============================================================ */

  function init() {
    cacheEls();
    mountCards();
    Store.subscribe(renderAll);
    /* 不做任何恢复：卡片、事件列表、D3 状态机全部只活在内存里，
       刷新即回到「等第一条报文」，由本次会话新收到的数据重新建立
       （跨端一致性靠 MQTT 干预广播收敛） */
    renderAll();          // 首屏为空态，等待 MQTT 推送
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
    /* 会话内记录（只存内存，刷新即清零） */
    history: {
      limit: RECORD_LIMIT,
      records: historyRecords,        // 同一个引用，不复制
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
    /* D3 干预—验证—恢复：事件状态机。四端各有一份实现，靠同一套规则与
       MQTT 广播收敛。 */
    events: {
      OPEN: EV_OPEN, HANDLING: EV_HANDLING, RECOVERED: EV_RECOVERED,
      recoverSamples: 1,
      relapseSamples: EV_RELAPSE_SAMPLES,
      confidenceFloor: EV_CONFIDENCE_FLOOR,
      actions: EV_ACTIONS,
      label: EV_LABEL,
      list: function () { return Store.events; },        // 同一个引用，不复制
      active: function (zoneId) {
        return zoneId === undefined ? Store.activeEvents : Store.activeEvents[zoneId];
      },
      /* 提交干预（等价于在卡片上勾选后点【执行干预】）。
         默认走广播，publish:false 时只在本端生效，供单端状态机测试使用 */
      intervene: function (zoneId, actions, actor, publish) {
        var list = (actions || []).slice();
        pendingActions[zoneId] = list;
        var ev = Store.intervene(zoneId, list, { actor: actor || 'mobile' });
        if (ev) {
          pendingActions[zoneId] = [];
          if (publish !== false) Mqtt.publishIntervention(ev, list);
        }
        return ev;
      },
      /* 模拟从别端广播来的干预，供跨端一致性测试用 */
      receive: function (msg) { return Store.receiveIntervention(msg); },
      connected: function () { return Mqtt.isConnected(); },
      /* 卡片正文的文字内容：测试直接读它来断言「干预信息只在卡片里用文字展示」 */
      cardText: function (zoneId) {
        var c = cards[zoneId];
        return c && c.eventBox && !c.eventBox.hidden
          ? c.eventBox.textContent.replace(/\s+/g, ' ').trim() : '';
      },
      cardState: function (zoneId) {
        var c = cards[zoneId];
        return c && c.eventBox && !c.eventBox.hidden ? c.eventBox.getAttribute('data-state') : null;
      },
      submit: function (zoneId) { return submitIntervention(zoneId); },
      pending: function (zoneId) { return (pendingActions[zoneId] || []).slice(); }
    },
    /* MQTT 客户端本体：联调时用来查看连接状态、或替换成桩件验证发布路径 */
    mqtt: Mqtt,
    pushReading: function (topic, payload) {
      Store.ingest(topic, typeof payload === 'string' ? payload : JSON.stringify(payload));
    }
  };

})();
