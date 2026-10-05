/* =============================================================================
 * AirGuard 校园多区域空气质量与人流监测预警协同系统 · Web 监测大屏
 *
 * 数据链路（全系统共用同一份实时状态）：
 *   感知采集节点 → MQTT/JSON → Store（共享实时状态） → Web 监测台 / 移动端 / 地图3D
 *
 * 本文件不含任何写死的示例数据：
 *   页面启动时所有指标为空，只有收到 MQTTX / python 端推送的报文才渲染。
 *
 * 报文约定
 *   主题： Airguard-x9k2m/+/data          （+ 为区域通配符，例如 Airguard-x9k2m/zone-n/data）
 *   载荷： { zoneid, pm25, co2, crowdLevel, status, time }
 *     zoneid      区域编号（zone-n / zone-s / zone-w），与主题区域做双重校验
 *     pm25        PM2.5 浓度，单位 μg/m³
 *     co2         CO₂ 浓度，单位 ppm
 *     crowdLevel  人流等级：0=正常，1=拥挤，2=严重拥挤
 *     status      上报状态。不信任该字段，一律按阈值本地重算
 *     time        采样时间
 *
 * 预警规则（本地重算，PM2.5 优先于 CO₂）
 *   pm25 > 150           → 重度污染
 *   pm25 > 75            → 轻度污染
 *   co2 >= 1500          → 通风不足风险
 *   以上都不满足          → 正常
 * ========================================================================== */
(function () {
  'use strict';

  /* ===========================================================================
   * 1. 配置
   * ======================================================================== */

  var CONFIG = {
    /* ---- MQTT 接入配置（改这里即可切换 Broker / 主题）---- */
    mqtt: {
      url: 'wss://broker.emqx.io:8084/mqtt',        // 公网 Broker（EMQX）的 WSS 地址
      topic: 'Airguard-x9k2m/+/data',          // + 通配符：一次订阅全部区域的 data 主题
      /* 干预动作的广播主题。与 Airguard-x9k2m/+/data 不冲突：
         'Airguard-x9k2m/+/data' 的第二层是 '+'、第三层必须是 data，
         而干预报文是 'Airguard-x9k2m/intervention/<zoneId>'，第三层是区域号。 */
      interventionTopic: 'Airguard-x9k2m/intervention/+',
      interventionPrefix: 'Airguard-x9k2m/intervention/',
      qos: 0,
      options: {
        clientId: 'airguard-web-' + Math.random().toString(16).slice(2, 8),
        clean: true,
        connectTimeout: 5000,
        reconnectPeriod: 3000,           // 断线后每 3 秒自动重连
        keepalive: 30
      }
    },

    historySize: 40,     // 趋势曲线最多保留的采样点数量
    maxAlerts: 30,       // 事件列表最多保留的条数
    maxPerception: 30,   // 感知记录最多保留的条数（内存环形，不落盘）
    maxEvents: 50,       // D3 干预事件在内存里保留的条数（不落盘，刷新即清空）
    mergeWindowMs: 2000, // 同一时刻内的多条报文合并为一个采样点（便于三区横向对比）

    /* ---- 记录上限 ----
       四端一律不落盘：没有任何 localStorage 键，页面刷新即全部清零，
       状态全部由 MQTT 实时流重建 */
    historyLimit: 5000,                     // 内存里最多保留 5000 条导出记录，超出丢最旧的
  };

  /* ---------------------------------------------------------------------------
   * 导出用的历史记录：每收到一条通过校验的 MQTT 报文就追加一条，
   * 字段顺序固定为 time, zone, pm25, co2, crowdLevel, status，与 CSV 表头一一对应。
   * 刻意挂到 window 上——这样它是真正的全局数组，控制台里直接敲 historyRecords 就能检视。
   *
   * 只在内存里：不落盘、刷新即清零，导出拿到的是本次会话收到的记录。
   * ------------------------------------------------------------------------ */
  var historyRecords = window.historyRecords = [];

  /* 三个监测区域。color 为区域身份色（分类色固定顺序，不随告警排序改变） */
  var ZONES = [
    { id: 'zone-n', name: '宿舍区', color: '#2a78d6' },
    { id: 'zone-s', name: '教学区', color: '#eb6834' },
    { id: 'zone-w', name: '食堂区', color: '#1baf7a' }
  ];

  /* 预警级别定义。rank 越大越严重，用于挑选重点关注区域 */
  var LEVELS = {
    good:     { key: 'good',     label: '正常',         glyph: '●', rank: 0, hex: '#0ca30c' },
    warning:  { key: 'warning',  label: '轻度污染',     glyph: '▲', rank: 1, hex: '#fab219' },
    serious:  { key: 'serious',  label: '通风不足风险', glyph: '◆', rank: 2, hex: '#ec835a' },
    critical: { key: 'critical', label: '重度污染',     glyph: '■', rank: 3, hex: '#d03b3b' }
  };

  /* 人流等级：报文 crowdLevel 字段的 0 / 1 / 2 / 3 四档取值。
     四端（Web / 移动端 / 3D 沙盘 / 分析报告）统一用这一套标签。
     早先这里是三档、且把 3 静默截断成 2，与其余三端对不上——CSV 里确实出现过
     crowdLevel=3，截断等于把「严重拥挤」这一档整个丢掉。 */
  var CROWD_LEVELS = {
    0: { label: '稀疏',     hex: '#898781', pct: 0 },
    1: { label: '正常',     hex: '#0ca30c', pct: 33 },
    2: { label: '拥挤',     hex: '#fab219', pct: 67 },
    3: { label: '严重拥挤', hex: '#d03b3b', pct: 100 }
  };

  /* 热力图归一化量程（人流等级按 0–3 四档归一化） */
  var RANGES = {
    pm25:  { min: 0,   max: 200,  unit: 'μg/m³' },
    co2:   { min: 400, max: 2000, unit: 'ppm' },
    crowd: { min: 0,   max: 3,    unit: '级' }
  };

  /* ---------------------------------------------------------------------------
   * 持续风险与优先关注：打分规则
   *   总分 = 环境异常分 + 人流分
   *     人流分 = 人流等级数值本身（稀疏 0 / 正常 1 / 拥挤 2 / 严重拥挤 3）
   *     环境分 = 该区域末尾连续异常条数：0 条 → 0 分；1 条 → 1 分；≥2 条 → 3 分
   *   持续时间 = 本轮连续异常「末条记录时刻 − 首条记录时刻」，按报文时间戳算。
   *     用报文时间戳而不是墙上时钟：报告端是末尾快照，没有「现在」，只有报文
   *     时间戳是四端都拿得到的量。连续 0 条或 1 条时持续时间为 0。
   *   同分裁决链（逐级比较，降到哪一级就用哪一级的说法写理由）：
   *     总分 → 持续时间 → 环境分 → 人流分 → 固定区域顺序（ZONES 的先后）
   *   Web / 移动端 / 3D 沙盘 / 分析报告各实现一遍，四处必须逐字一致。
   * ------------------------------------------------------------------------ */
  var PRIORITY_ENV_SINGLE = 1;     // 单次异常
  var PRIORITY_ENV_STREAK = 3;     // 连续多次异常
  var PRIORITY_SOURCE = 'review';  // 感知记录来源，全系统固定；confidence 固定为 null

  /* ---------------------------------------------------------------------------
   * D3【干预—验证—恢复】事件状态机
   *   OPEN 待处理 → HANDLING 处理中 → RECOVERED 已恢复。
   *
   *   流转合法性由规则本身保证，没有旁路：
   *     · 只有「无事件 + 监测到异常」才建事件（→ OPEN）
   *     · 只有「管理员在卡片内提交干预动作」才 OPEN → HANDLING
   *     · 只有「干预后收到一条满足恢复阈值的新监测数据」才
   *       HANDLING → RECOVERED —— 点按钮永远不可能直接置为已恢复
   *     · OPEN → RECOVERED 这条跳转在代码里根本不存在
   *     · RECOVERED 之后到达的迟到/重复消息只入历史日志，不回滚状态
   *
   *   消息健壮性三条（四端同款，判据都取报文内的时间与载荷）：
   *     · 重复：优先 message_id，没有才用 zoneId + time + 载荷哈希，只生效一次
   *     · 乱序：后到达的旧消息不回写实时读数、不开新事件，只进历史与日志
   *     · 迟到：早于事件水位线的旧消息不回滚已 RECOVERED 的事件，仅存档
   *
   *   四端（Web / 移动端浏览器版 / 小程序 / 3D 沙盘）各自实现同一套规则，
   *   彼此之间靠 MQTT 广播干预动作收敛，不能各自定义状态。
   * ------------------------------------------------------------------------ */
  var EV_OPEN = 'OPEN', EV_HANDLING = 'HANDLING', EV_RECOVERED = 'RECOVERED';
  var EV_RELAPSE_SAMPLES = 2;     // 干预后连续这么多组数据严重度高于干预时 → 回退 OPEN
                                  // （恢复不设门槛：干预后第一条达标数据即判定恢复）
  var EV_CONFIDENCE_FLOOR = 0.6;  // 低于此值视为低可信度感知数据
  var EV_DEDUPE_MAX = 500;        // 去重键保留上限（超出丢最旧的，避免无限增长）
  var EV_LOG_MAX = 40;            // 单个事件最多留存的原始消息条数

  /* 干预动作候选：按异常类型分组，卡片里多选。
     key 与 LEVELS 的 key 对齐（warning / serious / critical），人流拥挤用 crowd2 / crowd3 */
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

  var SEQ_BINS = 7;   // 顺序色阶分箱数

  /* ===========================================================================
   * 2. 共享实时状态（Store）—— 全系统唯一数据源
   * ======================================================================== */

  var Store = (function () {
    var state = {
      zones: {},        // zoneId -> 最新读数（未收到数据时该区域不存在）
      history: [],      // 趋势采样点 [{ ts, label, values: {zoneId: pm25|null} }]
      alerts: [],       // 告警事件，最新在前，最多 CONFIG.maxAlerts 条
      lastMessageAt: null,
      focusZoneId: null,
      focus: null,
      conn: 'connecting',   // connecting | connected | error | disconnected
      connNote: '正在连接 MQTT Broker，等待感知节点上报数据…',
      counters: { messages: 0, rejected: 0, statusMismatch: 0, duplicates: 0 },
      streaks: {},          // zoneId -> 末尾连续异常条数（见 2.7 节）
      streakStart: {},      // zoneId -> 本轮连续异常首条记录的时刻（ms），正常时清空
      perception: [],       // 感知记录，最新在前，最多 CONFIG.maxPerception 条
      priority: { rows: [], winner: null },  // 优先关注打分结果
      /* ---- D3 ---- */
      events: [],           // 全部干预事件，新的在前，最多 CONFIG.maxEvents 条
      activeEvents: {}      // zoneId -> 该区域当前（或最近一个）事件对象，与 events 里是同一个引用
    };

    var listeners = [];
    var alertSeq = 0;
    var perceptionSeq = {};   // zoneId -> 该区域已产生的感知记录条数（imageId 用）
    var eventSeq = 0;         // event_id 自增段
    var seenKeys = [];        // 已处理过的消息去重键，配合 seenSet 做 O(1) 判定
    var seenSet = {};

    function notify() {
      for (var i = 0; i < listeners.length; i++) listeners[i](state);
    }

    /* -------------------------------------------------------------------
     * 2.1 预警判断：不信任报文里的 status，一律按阈值本地重算
     *     PM2.5 优先于 CO₂（PM2.5 超限时不再看 CO₂）
     * ----------------------------------------------------------------- */
    function evaluateLevel(pm25, co2) {
      if (pm25 > 150) return 'critical';   // 重度污染
      if (pm25 > 75)  return 'warning';    // 轻度污染
      if (co2 >= 1500) return 'serious';   // 通风不足风险
      return 'good';
    }

    /* -------------------------------------------------------------------
     * 2.2 字段读取：键名大小写不敏感，兼容 zoneid / zoneId / zone_id
     * ----------------------------------------------------------------- */
    function field(obj, names) {
      var keys = Object.keys(obj);
      for (var i = 0; i < names.length; i++) {
        for (var j = 0; j < keys.length; j++) {
          if (keys[j].toLowerCase() === names[i]) return obj[keys[j]];
        }
      }
      return undefined;
    }

    /* -------------------------------------------------------------------
     * 2.3 写入一条读数（唯一的入库入口，外部也通过它注入数据）
     * ----------------------------------------------------------------- */
    function ingest(payload, zoneId, opts) {
      opts = opts || {};
      var pm25 = num(field(payload, ['pm25', 'pm2_5', 'pm2.5']), null);
      var co2 = num(field(payload, ['co2', 'co2_ppm', 'eco2']), null);
      var crowd = num(field(payload, ['crowdlevel', 'crowd_level', 'crowd']), null);

      // 三项指标缺任意一项都视为无效报文，避免半截数据污染大屏
      if (pm25 === null || co2 === null || crowd === null) return null;

      var rawTime = field(payload, ['time', 'ts', 'timestamp']);
      var parsedTs = parseStamp(rawTime);
      var recvTs = Date.now();

      /* 带了时间却解析不出来：这条只能按接收顺序排队，乱序判定对它失效。
         在控制台点破，免得现场排查时误以为状态机没生效 */
      if (rawTime !== undefined && rawTime !== null && String(rawTime).trim() !== '' && parsedTs === null) {
        console.warn('[AirGuard] 报文 time 无法解析，已退回接收时刻：' + zoneId + ' → ' + rawTime);
      }

      var level = evaluateLevel(pm25, co2);
      var info = LEVELS[level];
      var zone = findZone(zoneId);

      // 校验报文自带的 status 与本地重算结果是否一致（仅用于提示，不作为依据）
      var reported = field(payload, ['status', 'state']);
      if (typeof reported === 'string' && reported.trim() && reported.trim() !== info.label) {
        state.counters.statusMismatch++;
        console.warn('[AirGuard] 上报 status 与本地重算不一致，已采用重算结果：',
                     '上报=' + reported.trim(), '重算=' + info.label, 'zone=' + zoneId);
      }

      var reading = {
        zoneId: zoneId,
        zone: zone,
        pm25: Math.round(pm25),
        co2: Math.round(co2),
        crowdLevel: clamp(Math.round(crowd), 0, 3),
        reportedStatus: typeof reported === 'string' ? reported : '',
        level: level,
        levelInfo: info,
        load: compositeLoad(pm25, co2, crowd),
        ts: parsedTs || recvTs,
        timeShort: fmtTime(parsedTs || recvTs),
        timeFull: parsedTs ? fmtTime(parsedTs) : String(rawTime || fmtTime(recvTs)),
        stampFull: fmtStampFull(parsedTs || recvTs),
        recvTime: fmtTime(recvTs),
        verified: !!opts.verified,    // 主题与报文区域是否双重校验通过
        cached: !!opts.cached,        // 来自本地存储的历史读数，不是本次会话收到的报文
        lowConfidence: isLowConfidence(payload),  // D3：低可信度数据不能促成恢复
        duplicate: false              // D3：被去重拦下的报文，只回执不入库
      };

      /* ---- D3 消息健壮性：重复消息只生效一次 ----
         判据优先 message_id，没有才用 zoneId + time + 载荷指纹（event_id 不参与）。
         被拦下的报文不改状态、不计消息数、不建事件、不进历史日志、不生成感知记录。
         缓存回灌不是「刚收到的报文」，不参与去重。 */
      if (!opts.cached && isDuplicate(dedupeKey(payload, zoneId, reading))) {
        reading.duplicate = true;
        state.counters.duplicates++;
        console.warn('[AirGuard] 重复报文已忽略：' + zoneId + ' @ ' + reading.timeFull);
        return reading;
      }

      /* ---- D3 消息健壮性：乱序消息不覆盖更新的实时状态 ----
         报文时间早于本会话已入住的读数，就是「后到达的旧消息」。它照样算收到、
         照样进历史流水与感知记录，但不能回写实时读数、不动连续异常计数、不进
         趋势图，也不能凭一个更早的时间去开新事件 —— 那同样是旧消息覆盖新状态。
         跨会话不比较：存档读数标着 cached，对方时钟被重置过时，仍以实时报文为准。 */
      var prevReading = state.zones[zoneId];
      if (!opts.cached && prevReading && !prevReading.cached && reading.ts < prevReading.ts) {
        reading.outOfOrder = true;
        state.lastMessageAt = recvTs;
        state.counters.messages++;
        addPerception(reading);
        addAlert(reading);
        /* 只往已有事件的日志里补一笔；没有事件就不建 —— 旧消息不产生新状态 */
        if (state.activeEvents[zoneId]) applyEvent(reading);
        notify();
        return reading;
      }

      state.zones[zoneId] = reading;

      /* 连续异常计数：正常即归零。刷新页面后从头算起——
         恢复只回放每区域最后一条记录，「连续了几次」无从得知，按单次计。
         这是本模块已知的口径损耗：连续分只在页面存活期间累积。 */
      if (level === 'good') {
        state.streaks[zoneId] = 0;
        state.streakStart[zoneId] = null;
      } else if (opts.cached) {
        /* 回放只知道「末尾这条是异常」，连续了几次、从哪一刻起都无从得知，
           按单次计，起点也只能记成这条自己 —— 时长自然是 0 */
        state.streaks[zoneId] = 1;
        state.streakStart[zoneId] = reading.ts;
      } else {
        // 0 → 1 是本轮连续异常的起点，只有这一跳才写 streakStart
        if (!state.streaks[zoneId]) state.streakStart[zoneId] = reading.ts;
        state.streaks[zoneId] = (state.streaks[zoneId] || 0) + 1;
      }

      /* 缓存回灌复用同一条入库路径（这样卡片的渲染逻辑只有一份），
         但它不是「刚收到的报文」，所以到此为止：不推进 lastMessageAt、
         不计入消息数、不产生告警、不生成感知记录。
         否则每刷新一次页面就凭空多出一批告警。 */
      if (opts.cached) {
        computeFocus();
        computePriority();
        notify();
        return reading;
      }

      state.lastMessageAt = recvTs;
      state.counters.messages++;
      addPerception(reading);

      /* 每一条通过校验的报文都进事件列表，正常读数也在内——
         列表现在是一条完整的状态流水，不只是告警；正常行在渲染层会被压暗，
         颜色与徽章仍然只表示结论等级，不会把真正的告警淹掉 */
      addAlert(reading);

      /* D3：每条通过去重的报文都推进一次事件状态机 */
      applyEvent(reading);

      appendSample(zoneId, reading.pm25, recvTs);
      computeFocus();     // 必须在 notify 之前算好，否则重点关注区域会慢一帧
      computePriority();
      notify();
      return reading;
    }

    /* -------------------------------------------------------------------
     * 2.7 持续风险与优先关注
     *     感知记录：每条通过校验的报文派生一条，字段与报告端一致。
     *     source 与 confidence 在本地没有真实来源，写死而不是留空，
     *     是为了让「这条记录是怎么来的」在界面上一眼可见。
     * ----------------------------------------------------------------- */
    function addPerception(reading) {
      var n = (perceptionSeq[reading.zoneId] || 0) + 1;
      perceptionSeq[reading.zoneId] = n;
      state.perception.unshift({
        zoneId: reading.zoneId,
        // 真实系统里这里是抓拍图编号；本地没有图片，用「相机 + 区域 + 该区域第几条」
        // 拼出来，既能唯一标识，也比随机数好核对
        imageId: 'cam-' + reading.zoneId + '-' + String(n).padStart(4, '0'),
        crowdLevel: crowdInfo(reading.crowdLevel).label,
        confidence: null,
        source: PRIORITY_SOURCE,
        // 完整到日期：感知记录是存档性质的，只写 HH:MM:SS 跨天就没法核对了
        time: reading.stampFull
      });
      if (state.perception.length > CONFIG.maxPerception) {
        state.perception.length = CONFIG.maxPerception;
      }
    }

    /* -------------------------------------------------------------------
     * 2.8 D3【干预—验证—恢复】事件状态机
     * ----------------------------------------------------------------- */

    /* 严重度：环境等级优先、人流次之。干预后拿它跟「干预那一刻的严重度」比，
       判断是持续恶化（回退 OPEN）还是仅仅还没达标（保持 HANDLING） */
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
       字段缺失＝常规感知数据（可信），兼容现状 —— 现有采集端不发这个字段。 */
    function isLowConfidence(payload) {
      var c = num(field(payload, ['confidence', 'conf', 'credibility', '可信度']), null);
      return c !== null && c < EV_CONFIDENCE_FLOOR;
    }

    /* 优先关注理由：把「为什么是它」写成人话存进事件字段 */
    function buildReason(reading) {
      var lv = LEVELS[reading.level];
      var ci = crowdInfo(reading.crowdLevel);
      return 'PM2.5 ' + reading.pm25 + ' μg/m³ / CO₂ ' + reading.co2 + ' ppm（' + lv.label +
             '）+ 人流' + ci.label + ' ' + reading.crowdLevel + ' 级 → 严重度 ' +
             severityOf(lv.rank, reading.crowdLevel);
    }

    /* 这条读数该配哪一组干预动作（异常类型决定组别） */
    function actionKeyOf(reading) {
      if (eventTypeOf(LEVELS[reading.level].rank, reading.crowdLevel) === '人流拥挤') {
        return 'crowd' + clamp(reading.crowdLevel, 2, 3);
      }
      return reading.level;
    }

    /* 消息去重键。优先报文自带的 message_id；没有才用 zoneId + 时间 + 载荷指纹。
       event_id 绝不参与去重 —— 它标记的是同一个「持续事件」，跨多条消息保持不变，
       拿它去重会把同一事件后续的验证数据全部误杀。 */
    function dedupeKey(payload, zoneId, reading) {
      var mid = field(payload, ['message_id', 'messageid', 'msgid', 'msg_id']);
      if (mid !== undefined && mid !== null && String(mid).trim() !== '') {
        return zoneId + '|mid|' + String(mid).trim();
      }
      return zoneId + '|sum|' + fnv1a([
        zoneId, reading.timeFull, reading.pm25, reading.co2, reading.crowdLevel, reading.level
      ].join('|'));
    }

    function isDuplicate(key) {
      if (Object.prototype.hasOwnProperty.call(seenSet, key)) return true;
      seenSet[key] = 1;
      seenKeys.push(key);
      if (seenKeys.length > EV_DEDUPE_MAX) delete seenSet[seenKeys.shift()];
      return false;
    }

    function pushLog(ev, reading, note) {
      ev.log.push({
        time: reading.timeFull,
        ts: reading.ts,
        level: reading.level,
        levelLabel: reading.levelInfo.label,
        crowdLevel: reading.crowdLevel,
        note: note
      });
      if (ev.log.length > EV_LOG_MAX) ev.log.shift();
    }

    function createEvent(reading) {
      var rank = LEVELS[reading.level].rank;
      var ev = {
        event_id: 'evt-' + reading.zoneId + '-' + (++eventSeq) + '-' + reading.ts,
        zoneId: reading.zoneId,
        zoneName: reading.zone.name,
        startedAt: reading.timeFull,      // 事件开始时间
        startedTs: reading.ts,
        type: eventTypeOf(rank, reading.crowdLevel),   // 异常类型
        priorityReason: buildReason(reading),          // 优先关注理由
        userActions: [],                  // 用户干预动作记录
        verifySamples: [],                // 干预后多组验证数据集
        state: EV_OPEN,                   // 当前事件状态
        interventionAt: null,             // 干预提交时刻
        severityAtIntervention: null,
        recoveredAt: null,                // 恢复时间
        outcome: '待处理',                // 最终结果
        manualReview: false,              // 低可信度数据触发的「人工复核」标记
        severity: severityOf(rank, reading.crowdLevel),
        actionKey: actionKeyOf(reading),
        lastTs: reading.ts,               // 已处理到的最新报文时刻，用于识别乱序/迟到
        relapseSamples: 0,
        log: []
      };
      pushLog(ev, reading, '监测捕获异常，事件建立');

      state.events.unshift(ev);
      if (state.events.length > CONFIG.maxEvents) state.events.length = CONFIG.maxEvents;
      state.activeEvents[reading.zoneId] = ev;
      return ev;
    }

    /* 事件机唯一入口。每条通过去重的报文进来一次。
       乱序 / 迟到（时间戳早于本事件已处理的最后一条）不参与状态判断，只入日志。 */
    function applyEvent(reading) {
      var zoneId = reading.zoneId;
      var rank = LEVELS[reading.level].rank;
      var crowd = reading.crowdLevel;
      var ev = state.activeEvents[zoneId] || null;

      /* ---- 无事件：只有确实异常才建 ---- */
      if (!ev) {
        if (!isAbnormal(reading.level, crowd)) return null;
        return createEvent(reading);
      }

      /* ---- 乱序 / 迟到：旧消息不能覆盖更新后的最新状态 ---- */
      if (reading.ts < ev.lastTs) {
        pushLog(ev, reading, '迟到/乱序消息，仅存档，不参与状态判断');
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
          return createEvent(reading);
        }
        pushLog(ev, reading, '事件已恢复，后续消息仅存档');
        return ev;
      }


      /* ---- OPEN 待处理：数据只刷新严重度与理由，状态不动 ---- */
      if (ev.state === EV_OPEN) {
        ev.severity = severityOf(rank, crowd);
        ev.priorityReason = buildReason(reading);
        ev.actionKey = actionKeyOf(reading);
        pushLog(ev, reading, '待处理中的数据更新');
        return ev;
      }

      /* ---- HANDLING 处理中：只能由新监测数据判定，按钮到不了这里 ---- */

      /* 低可信度感知数据不能促成恢复。若这条本可判恢复，标记人工复核并作废这条数据，
         状态保持 HANDLING —— 宁可不恢复，也不能让一条不可信的数据把事件关掉。 */
      if (reading.lowConfidence) {
        if (isRecoveredEnv(reading.level, crowd)) {
          ev.manualReview = true;
          ev.verifySamples.length = 0;
          ev.outcome = '低可信度数据，已标记人工复核';
        }
        pushLog(ev, reading, '低可信度数据，不参与恢复判定');
        return ev;
      }

      if (isRecoveredEnv(reading.level, crowd)) {
        ev.manualReview = false;
        ev.relapseSamples = 0;
        /* 干预后的验证数据仍然留档（事件字段要求有「干预后验证数据集」），
           但恢复不设门槛：第一条达标数据就判定恢复，不再累计条数 */
        ev.verifySamples.push({
          time: reading.timeFull,
          pm25: reading.pm25,
          co2: reading.co2,
          crowdLevel: crowd,
          level: reading.level
        });
        ev.state = EV_RECOVERED;
        ev.recoveredAt = reading.timeFull;
        ev.outcome = '已恢复';
        pushLog(ev, reading, '收到正常监测数据，自动判定恢复');
        return ev;
      }

      /* 不达标：严重度高于干预那一刻才算恶化 */
      ev.verifySamples.length = 0;
      if (severityOf(rank, crowd) > ev.severityAtIntervention) {
        ev.relapseSamples++;
        if (ev.relapseSamples >= EV_RELAPSE_SAMPLES) {
          ev.state = EV_OPEN;
          ev.relapseSamples = 0;
          ev.outcome = '干预无效，回退待处理';
          ev.severity = severityOf(rank, crowd);
          ev.priorityReason = buildReason(reading);
          ev.actionKey = actionKeyOf(reading);
          pushLog(ev, reading, '连续 ' + EV_RELAPSE_SAMPLES + ' 组数据恶化，回退 OPEN');
        } else {
          ev.outcome = '仍需关注';
          pushLog(ev, reading, '数据恶化 ' + ev.relapseSamples + '/' + EV_RELAPSE_SAMPLES);
        }
      } else {
        ev.relapseSamples = 0;
        ev.outcome = '仍需关注';
        pushLog(ev, reading, '数据未达标，继续观察');
      }
      return ev;
    }

    /* 提交干预动作。只有 OPEN 能提交；这里绝不会把状态置成 RECOVERED ——
       恢复只能由后续新监测数据自动判定。返回事件对象表示提交成功，null 表示被拒。 */
    function intervene(zoneId, actions, meta) {
      var ev = state.activeEvents[zoneId];
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
        actor: meta.actor || 'web'
      });
      ev.interventionAt = ev.userActions[ev.userActions.length - 1].at;
      ev.severityAtIntervention = ev.severity;
      ev.verifySamples.length = 0;
      ev.relapseSamples = 0;
      ev.manualReview = false;
      ev.outcome = '干预已提交，等待新监测数据验证';
      pushLog(ev, {
        timeFull: ev.interventionAt,
        ts: (meta.ts || Date.now()),
        level: '',
        levelInfo: { label: '' },
        crowdLevel: null
      }, '管理员提交干预：' + list.join(' / '));
      notify();
      return ev;
    }

    /* 接收别端广播来的干预动作。event_id 对不上说明是别的（更早或更晚）事件，忽略；
       状态已经不是 OPEN 也忽略。因此同一条干预重复到达天然幂等。 */
    function receiveIntervention(msg) {
      if (!msg || typeof msg !== 'object') return null;
      var zoneId = deriveZoneId(msg.zoneId || msg.zoneid || msg.zone);
      if (!zoneId) return null;
      var ev = state.activeEvents[zoneId];
      if (!ev || ev.event_id !== msg.event_id || ev.state !== EV_OPEN) return null;
      return intervene(zoneId, msg.actions, { at: msg.at || msg.time, actor: msg.actor || 'remote' });
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
      /* 按 ZONES 的固定顺序遍历。裁决链前四级全平时先到先得，等于「区域顺序」兜底，
         同一批数据算出来永远是同一个结果，不会在两个区域之间来回跳。 */
      for (var i = 0; i < ZONES.length; i++) {
        var zid = ZONES[i].id;
        var z = state.zones[zid];
        if (!z) continue;

        var streak = state.streaks[zid] || 0;
        var env = streak === 0 ? 0
                : (streak === 1 ? PRIORITY_ENV_SINGLE : PRIORITY_ENV_STREAK);
        var crowd = clamp(z.crowdLevel, 0, 3);
        /* 持续时间只看本轮连续异常：末条记录时刻 − 首条记录时刻。
           streak 为 0 或 1 时首末同一条，时长 0 */
        var started = state.streakStart[zid];
        var span = (streak > 0 && started != null) ? Math.max(0, z.ts - started) : 0;
        var row = {
          zoneId: zid,
          name: z.zone.name,
          color: z.zone.color,
          streak: streak,
          span: span,
          spanText: spanText(span),
          level: z.level,
          levelLabel: z.levelInfo.label,
          env: env,
          crowd: crowd,
          crowdLabel: crowdInfo(crowd).label,
          total: env + crowd
        };
        row.reason = priorityReason(row);
        rows.push(row);
      }

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
      state.priority = { rows: rows, winner: top };
    }

    /* -------------------------------------------------------------------
     * 2.4 事件记录：每条报文新增一条（含正常读数），列表最多保留 CONFIG.maxAlerts 条
     *     数组恒定「新的在前」，渲染与调试导出都依赖这个顺序
     * ----------------------------------------------------------------- */
    function addAlert(reading) {
      state.alerts.unshift({
        id: 'ev-' + (++alertSeq),
        zoneId: reading.zoneId,
        zoneName: reading.zone.name,
        zoneColor: reading.zone.color,
        level: reading.level,
        type: reading.levelInfo.label,
        // 正常读数没有「触发值」，改写成与区域卡片一致的说明，不留空格子
        trigger: triggerText(reading) || '各项指标在阈值内',
        ts: reading.ts,
        timeShort: reading.timeShort,
        timeFull: reading.timeFull
      });
      if (state.alerts.length > CONFIG.maxAlerts) {
        state.alerts.length = CONFIG.maxAlerts;
      }
    }

    /* -------------------------------------------------------------------
     * 2.5 趋势采样点：每收到一条报文追加
     *     同一时刻（2 秒窗口内）到达的多条报文合并为一个点，
     *     这样用 MQTTX 连发三个区域时，曲线上是同一时刻的三个点，便于横向对比。
     * ----------------------------------------------------------------- */
    function appendSample(zoneId, pm25, ts) {
      var last = state.history[state.history.length - 1];

      if (!last || ts - last.ts > CONFIG.mergeWindowMs) {
        var slot = { ts: ts, label: fmtTime(ts), values: {} };
        for (var i = 0; i < ZONES.length; i++) slot.values[ZONES[i].id] = null;
        state.history.push(slot);
        last = slot;
        if (state.history.length > CONFIG.historySize) {
          state.history.shift();
        }
      }
      last.values[zoneId] = pm25;
    }

    /* -------------------------------------------------------------------
     * 2.6 重点关注区域：取级别最高的区域，同级比综合负载
     * ----------------------------------------------------------------- */
    function computeFocus() {
      var focus = null;
      for (var i = 0; i < ZONES.length; i++) {
        var z = state.zones[ZONES[i].id];
        if (!z) continue;
        var rank = LEVELS[z.level].rank;
        if (rank === 0) continue;
        if (!focus || rank > focus.rank || (rank === focus.rank && z.load > focus.load)) {
          focus = { zoneId: z.zoneId, name: z.zone.name, level: z.level, rank: rank, load: z.load };
        }
      }
      state.focusZoneId = focus ? focus.zoneId : null;
      state.focus = focus;
    }

    return {
      state: state,
      evaluateLevel: evaluateLevel,
      field: field,
      ingest: ingest,
      computeFocus: computeFocus,
      computePriority: computePriority,
      spanText: spanText,
      /* ---- D3 事件状态机 ---- */
      severityOf: severityOf,
      isAbnormal: isAbnormal,
      isRecoveredEnv: isRecoveredEnv,
      eventTypeOf: eventTypeOf,
      buildReason: buildReason,
      actionKeyOf: actionKeyOf,
      applyEvent: applyEvent,
      intervene: intervene,
      receiveIntervention: receiveIntervention,
      notify: notify,
      subscribe: function (fn) {
        listeners.push(fn);
        return function () { listeners = listeners.filter(function (f) { return f !== fn; }); };
      },
      setConn: function (conn, note) {
        state.conn = conn;
        if (note) state.connNote = note;
        notify();
      },
      /* 把内存状态整体归零，回到「等 MQTT 推送」的初始态。
         注意：这个不挂到任何按钮上——【清空本地记录】只清记录列表与导出缓存，
         区域卡片与趋势曲线保持不动（见 clearHistory）。这里留给联调与
         自动化测试手动复位用。连接状态（state.conn / connNote）保持不动。 */
      clearAll: function () {
        // 全部就地清空而不是换成新对象：state 的子对象可能已被外部持有引用
        // （getSnapshot 的调用方），换对象会让它们继续看到旧数据
        Object.keys(state.zones).forEach(function (k) { delete state.zones[k]; });
        state.history.length = 0;
        state.alerts.length = 0;
        state.lastMessageAt = null;
        state.focusZoneId = null;
        state.focus = null;
        state.counters.messages = 0;
        state.counters.rejected = 0;
        state.counters.statusMismatch = 0;
        // 优先关注模块的会话态：连续计数、本轮起点与感知记录都跟着一起归零
        Object.keys(state.streaks).forEach(function (k) { delete state.streaks[k]; });
        Object.keys(state.streakStart).forEach(function (k) { delete state.streakStart[k]; });
        state.perception.length = 0;
        state.priority.rows.length = 0;
        state.priority.winner = null;
        /* D3：事件、当前事件指向、去重表一起归零，回到「等第一条报文」的初始态。
           去重表也要清 —— 否则测试里重放同一批报文会被当成重复直接丢掉。 */
        state.events.length = 0;
        Object.keys(state.activeEvents).forEach(function (k) { delete state.activeEvents[k]; });
        seenKeys.length = 0;
        seenSet = {};
        eventSeq = 0;
        state.counters.duplicates = 0;
        notify();
      },
      /* 供移动端 / 地图3D 等其它端复用的快照 */
      getSnapshot: function () {
        return {
          zones: state.zones,
          focusZoneId: state.focusZoneId,
          lastMessageAt: state.lastMessageAt,
          alerts: state.alerts
        };
      }
    };
  })();

  /* ===========================================================================
   * 3. 工具函数
   * ======================================================================== */

  function findZone(id) {
    for (var i = 0; i < ZONES.length; i++) if (ZONES[i].id === id) return ZONES[i];
    return null;
  }

  /* 把各种写法归一化成标准区域编号：zone-n / n / 宿舍区 / dorm 都认 */
  function deriveZoneId(raw) {
    if (raw === undefined || raw === null) return null;
    var s = String(raw).trim();
    var low = s.toLowerCase();

    for (var i = 0; i < ZONES.length; i++) {
      if (low === ZONES[i].id || s === ZONES[i].name) return ZONES[i].id;
    }
    if (low === 'n' || low === 'north' || low.indexOf('dorm') >= 0) return 'zone-n';
    if (low === 's' || low === 'south' || low.indexOf('teach') >= 0) return 'zone-s';
    if (low === 'w' || low === 'west'  || low.indexOf('canteen') >= 0 || low.indexOf('dining') >= 0) return 'zone-w';
    return null;
  }

  /* 从主题里识别区域：Airguard-x9k2m/zone-n/data → zone-n */
  function zoneFromTopic(topic) {
    var parts = String(topic).split('/');
    for (var i = 0; i < parts.length; i++) {
      var z = deriveZoneId(parts[i]);
      if (z) return z;
    }
    return null;
  }

  function num(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    var n = typeof v === 'number' ? v : parseFloat(v);
    return isFinite(n) ? n : fallback;
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /* FNV-1a 32 位哈希。给没有 message_id 的报文算载荷指纹用——
     四端必须逐位一致，否则同一份报文在不同端的去重结果会对不上。 */
  function fnv1a(str) {
    var h = 0x811c9dc5;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return ('0000000' + h.toString(16)).slice(-8);
  }

  /* 采样时间解析：支持毫秒/秒时间戳、"2026-10-03 09:12:00"、ISO 字符串，
     以及只给了时分秒的 "09:12:00" / "09:12"（MQTTX 手写报文最常见的写法） */
  function parseStamp(v) {
    if (v === undefined || v === null || v === '') return null;
    if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;   // 10 位当秒，13 位当毫秒

    var s = String(v).trim();
    if (s === '') return null;

    /* 采集端把时间戳 stringify 成字符串的情况：与数字同等对待。
       不认这种写法的话，同一条报文在实时和恢复两条路径上会被区别对待。 */
    if (/^\d{10}$|^\d{13}$/.test(s)) {
      var n = Number(s);
      return n < 1e12 ? n * 1000 : n;
    }

    /* 带日期的时间：手写解析，不依赖各内核 Date 解析的宽松程度——
       "2026-10-4 13:28:00"（不补零）在部分内核上解析不出来，
       直接落回「接收时刻」，乱序判定就退化成「谁后到谁更新」。
       四端（web / map3d / mobile / 小程序）同一份口径。 */
    var fm = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (fm) {
      var df = new Date(Number(fm[1]), Number(fm[2]) - 1, Number(fm[3]),
                        Number(fm[4]), Number(fm[5]), Number(fm[6] || 0));
      return isNaN(df.getTime()) ? null : df.getTime();
    }

    /* 只有时分秒（"10:24:02" / "10:24"）：按今天补日期后再比。
       Date.parse 不认这种写法，解析不出来就会退回「接收时刻」——
       那等于把乱序判定退化成「谁后到谁更新」，后到的旧消息照样覆盖新状态。 */
    var hm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
    if (hm) {
      var d = new Date();
      d.setHours(Number(hm[1]), Number(hm[2]), Number(hm[3] || 0), 0);
      return d.getTime();
    }

    var t = Date.parse(s);
    if (isNaN(t)) t = Date.parse(s.replace(/-/g, '/'));   // 兼容部分内核对 "YYYY-MM-DD hh:mm:ss" 的解析差异
    return isNaN(t) ? null : t;
  }

  function pad2(n) { return n < 10 ? '0' + n : '' + n; }

  function fmtTime(ts) {
    var d = new Date(ts);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  /* 带日期的完整时间戳。页面上的时间只显示到秒（当天大屏够用），
     但导出的 CSV 要跨天存档，必须有日期。 */
  function fmtStampFull(ts) {
    var d = new Date(ts);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) +
           ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function fmtNum(v, digits) {
    if (v === null || v === undefined || !isFinite(v)) return '–';
    return digits ? v.toFixed(digits) : String(Math.round(v));
  }

  function normLoad(metric, value) {
    var r = RANGES[metric];
    return clamp((value - r.min) / (r.max - r.min), 0, 1);
  }

  /* 综合负载 = 三项指标各自归一化后的均值 */
  function compositeLoad(pm25, co2, crowd) {
    return (normLoad('pm25', pm25) + normLoad('co2', co2) + normLoad('crowd', crowd)) / 3;
  }

  /* 告警触发值：说明是哪一项指标触发的 */
  function triggerText(reading) {
    if (reading.level === 'critical' || reading.level === 'warning') {
      return 'PM2.5 ' + reading.pm25 + ' μg/m³';
    }
    if (reading.level === 'serious') return 'CO₂ ' + reading.co2 + ' ppm';
    return '';
  }

  function crowdInfo(code) {
    return CROWD_LEVELS[code] || { label: '未知', hex: '#898781', pct: 0 };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function $(id) { return document.getElementById(id); }

  /* ===========================================================================
   * 4. MQTT 接入（mqtt.js）
   * ======================================================================== */

  var Mqtt = (function () {
    var client = null;

    /* -------------------------------------------------------------------
     * 4.1 双重校验：主题识别区域 + 报文 zoneid 字段，两路必须一致
     *     返回 { zoneId, verified } 或 { error, detail }
     *     任一路写了「不是已知区域」的值、或两路互相矛盾，整条报文一律拒收；
     *     主题认不出区域时绝不回退到报文 zoneid —— 那正是串区报文的典型形态
     *     （主题 Airguard-x9k2m/zone-m/data + 报文 zoneId=zone-w）。
     *     四端同一口径：web / 手机端 / 小程序 / 3D 沙盘。
     * ----------------------------------------------------------------- */
    function resolveZone(topic, payload) {
      var fromTopic = zoneFromTopic(topic);
      var rawPayloadZone = Store.field(payload, ['zoneid', 'zone_id', 'zone']);
      var fromPayload = deriveZoneId(rawPayloadZone);
      var payloadZoneGiven = rawPayloadZone !== undefined && rawPayloadZone !== null &&
                             String(rawPayloadZone).trim() !== '';

      // 主题里没有可识别的区域段：拒收
      if (!fromTopic) {
        return {
          error: 'topic-zone',
          detail: '主题「' + topic + '」里没有可识别的区域段'
        };
      }

      // 报文带 zoneid 字段：必须是已知区域，且必须与主题指向同一区域
      if (payloadZoneGiven) {
        if (!fromPayload) {
          return {
            error: 'payload-zone',
            detail: '报文 zoneid「' + rawPayloadZone + '」不是已知区域'
          };
        }
        if (fromTopic !== fromPayload) {
          return {
            error: 'mismatch',
            detail: '主题指向 ' + fromTopic + '，报文 zoneid 却是 ' + fromPayload
          };
        }
        return { zoneId: fromTopic, verified: true };
      }

      // 报文没带 zoneid：按主题区域接收，标记为未通过双重校验
      return { zoneId: fromTopic, verified: false };
    }

    function onMessage(topic, payloadBuf) {
      var text = payloadBuf.toString();

      // ---- 干预广播走另一条分支：它不是读数，不进监测状态 ----
      if (String(topic).indexOf(CONFIG.mqtt.interventionPrefix) === 0) {
        onIntervention(topic, text);
        return;
      }

      // ---- 解析 JSON ----
      var data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        reject('报文不是合法 JSON', topic + ' → ' + text.slice(0, 120));
        return;
      }
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        reject('报文结构不是单个 JSON 对象', topic);
        return;
      }

      // ---- 双重校验区域 ----
      var r = resolveZone(topic, data);
      if (r.error === 'mismatch') {
        reject('区域校验不一致（疑似串区）', r.detail);
        return;
      }
      if (r.error) {
        reject('无法识别区域', r.detail + '（主题 ' + topic + '）');
        return;
      }

      // ---- 写入共享状态并立即刷新页面 ----
      var reading = Store.ingest(data, r.zoneId, { verified: r.verified });
      if (!reading) {
        reject('报文缺少 pm25 / co2 / crowdLevel 字段', topic + ' → ' + text.slice(0, 120));
        return;
      }

      /* 重复报文不再往下走：CSV 存档也要去重，否则同一条消息重发几次
         报告里的连续性统计就会被灌水（见 D3 消息健壮性） */
      if (reading.duplicate) return;

      // ---- 缓存本条报文，供导出 CSV ----
      // 这里刻意按报文原值入库，不做 Math.round 也不做 clamp：
      // CSV 是「收到过什么」的存档，口径与页面上经过归一化处理的展示值分开。
      var recTime = Store.field(data, ['time', 'ts', 'timestamp']);
      var recStatus = Store.field(data, ['status', 'state']);
      historyRecords.push({
        time: (recTime === undefined || recTime === null || recTime === '')
          ? fmtStampFull(Date.now())               // 报文没带时间就用本地接收时刻补上
          : String(recTime),
        zone: r.zoneId,
        pm25: num(Store.field(data, ['pm25', 'pm2_5', 'pm2.5']), null),
        co2: num(Store.field(data, ['co2', 'co2_ppm', 'eco2']), null),
        crowdLevel: num(Store.field(data, ['crowdlevel', 'crowd_level', 'crowd']), null),
        status: (recStatus === undefined || recStatus === null) ? '' : String(recStatus)
      });
      /* 导出记录只留在内存里：超上限就丢最旧的，否则连收几小时会一路涨上去 */
      var overHistory = historyRecords.length - CONFIG.historyLimit;
      if (overHistory > 0) historyRecords.splice(0, overHistory);

      setConnNote('已连接 · 最近一条：' + r.zoneId + ' · ' + topic +
                  (r.verified ? ' · 双重校验通过' : ' · ⚠ 仅单路可识别区域'));
    }

    /* -------------------------------------------------------------------
     * 4.2 干预动作广播
     *     没有后端服务，四端的状态一致靠「各自跑同一套状态机 + 干预动作广播」达成：
     *     任何一端提交干预，都往 Airguard-x9k2m/intervention/<zoneId> 发一条（retain，
     *     这样后打开的一端也能收到当前事件的处理状态）。
     *     收端只在 event_id 与本端当前事件吻合、且状态还是 OPEN 时才应用，
     *     所以自己发出去的那条回声、以及重复到达的同一条，都是幂等的。
     * ----------------------------------------------------------------- */
    function onIntervention(topic, text) {
      var data;
      try {
        data = JSON.parse(text);
      } catch (e) {
        console.warn('[AirGuard] 干预报文不是合法 JSON：' + topic);
        return;
      }
      if (!data || typeof data !== 'object' || data.type !== 'intervention') return;

      var ev = Store.receiveIntervention(data);
      if (ev) {
        setConnNote('已应用来自「' + (data.actor || '其它端') + '」的干预：' +
                    ev.zoneName + ' · ' + ev.state);
      }
    }

    /* 广播一次干预。发送失败不影响本端状态——本端该转 HANDLING 还是转了，
       其它端连接恢复后会靠 retain 的这条消息补齐。 */
    function publishIntervention(ev, actions) {
      if (!client || !client.connected) {
        console.warn('[AirGuard] MQTT 未连接，本次干预未广播到其它端');
        return false;
      }
      client.publish(CONFIG.mqtt.interventionPrefix + ev.zoneId,
        JSON.stringify({
          type: 'intervention',
          event_id: ev.event_id,
          zoneId: ev.zoneId,
          actions: actions,
          at: ev.interventionAt,
          actor: 'web'
        }), { qos: CONFIG.mqtt.qos, retain: true });
      return true;
    }

    /* 丢弃报文：累计计数并在状态条上提示，便于现场排查串区 */
    function reject(reason, detail) {
      Store.state.counters.rejected++;
      console.warn('[AirGuard] 报文已丢弃 —— ' + reason + '：' + detail);
      Store.setConn('connected', '⚠ 丢弃报文：' + reason + '（' + detail + '）');
    }

    function setConnNote(note) {
      Store.state.connNote = note;
      Store.notify();
    }

    return {
      start: function () {
        if (typeof window.mqtt === 'undefined') {
          Store.setConn('error', '⚠ mqtt.js 未能加载（CDN 不可达），请检查网络后刷新页面。');
          return;
        }

        Store.setConn('connecting', '正在连接 ' + CONFIG.mqtt.url + ' …');
        client = window.mqtt.connect(CONFIG.mqtt.url, CONFIG.mqtt.options);

        client.on('connect', function () {
          /* 一次订阅两个主题：读数 + 其它端广播来的干预动作 */
          client.subscribe([CONFIG.mqtt.topic, CONFIG.mqtt.interventionTopic],
            { qos: CONFIG.mqtt.qos }, function (err) {
            if (err) {
              Store.setConn('error', '⚠ 订阅失败：' + err.message);
              return;
            }
            Store.setConn('connected',
              '已连接 ' + CONFIG.mqtt.url + ' · 已订阅 ' + CONFIG.mqtt.topic +
              ' 与 ' + CONFIG.mqtt.interventionTopic + ' · 等待报文…');
          });
        });

        client.on('message', onMessage);
        client.on('reconnect', function () { Store.setConn('connecting', '连接断开，正在重连…'); });
        client.on('close',     function () { Store.setConn('disconnected', '连接已关闭，等待自动重连…'); });
        client.on('error',     function (err) {
          Store.setConn('error', '⚠ MQTT 异常：' + (err && err.message ? err.message : err) +
                                 '（请确认 Broker 已启动且 ' + CONFIG.mqtt.url + ' 为 websockets 监听）');
        });
      },
      isRunning: function () { return !!client; },
      isConnected: function () { return !!(client && client.connected); },
      publishIntervention: publishIntervention,
      /* 把一条原始报文喂进订阅回调：与真实 MQTT 收包走完全同一条路径。
         自动化测试用它验证串区 / 区域不可识别的报文确实被拒收。 */
      ingestRaw: function (topic, text) { onMessage(topic, String(text)); }
    };
  })();

  /* ===========================================================================
   * 5. 渲染
   * ======================================================================== */

  var el = {};
  var chart = null;
  var currentView = 'chart';
  var THEME = {};

  var IDS = ['kpiOnline', 'kpiOnlineSub', 'kpiAbnormal', 'kpiAbnormalSub', 'kpiAvgPm', 'kpiAvgPmSub',
             'kpiFocus', 'kpiFocusSub', 'focusNote', 'zoneGrid', 'heatBody', 'heatLegend',
             'trendCanvas', 'trendTableHead', 'trendTableBody', 'chartWrap', 'chartTableWrap', 'chartEmpty',
             'alertBody', 'alertCount', 'alertEmpty', 'clockTime', 'connText', 'connBar',
             'msgCount', 'rejectCount', 'statusMismatch', 'linkNote', 'topbar', 'brokerUrl',
             'priorityFocus', 'priorityScoreBody', 'priorityEmpty', 'priorityPanel',
             'eventGrid', 'eventEmpty',
             /* E2：语音 / 现场 / 朗读 */
             'micBtn', 'photoBtn', 'speakBtn', 'e2Status', 'cmdInput', 'photoGrid', 'photoEmpty', 'photoCount',
             'camOverlay', 'camVideo', 'camCanvas', 'camBind', 'camShoot', 'camPick', 'camCancel',
             'camFile', 'camNote'];

  function cacheEls() { IDS.forEach(function (id) { el[id] = $(id); }); }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  /* 主题色只在启动时读一次，避免绘制插件逐帧调用 getComputedStyle */
  function cacheTheme() {
    ['--surface', '--ink-1', '--ink-2', '--ink-muted', '--grid', '--axis'].forEach(function (v) {
      THEME[v] = cssVar(v);
    });
  }

  /* ---------- 5.1 顶栏：连接状态与统计 ---------- */

  function renderTopbar(state) {
    var connText = {
      connecting:   'MQTT 连接中',
      connected:    'MQTT 已连接',
      error:        'MQTT 连接异常',
      disconnected: 'MQTT 已断开'
    }[state.conn] || 'MQTT 未连接';

    el.connText.textContent = connText;
    el.topbar.dataset.conn = state.conn;
    el.brokerUrl.textContent = CONFIG.mqtt.url;   // 顶栏地址始终与 CONFIG 保持一致

    el.clockTime.textContent = state.lastMessageAt ? fmtTime(state.lastMessageAt) : '--:--:--';
    el.msgCount.textContent = state.counters.messages;
    el.rejectCount.textContent = state.counters.rejected;
    el.statusMismatch.textContent = state.counters.statusMismatch;

    el.linkNote.textContent = state.connNote;
    el.linkNote.classList.toggle('is-warn', /⚠/.test(state.connNote));
  }

  /* ---------- 5.2 多区域实时总览 ---------- */

  function renderKpi(state) {
    var list = ZONES.map(function (z) { return state.zones[z.id]; }).filter(Boolean);
    var abnormal = list.filter(function (z) { return z.level !== 'good'; });

    el.kpiOnline.innerHTML = list.length + '<span class="unit">/ ' + ZONES.length + '</span>';
    el.kpiOnlineSub.textContent = list.length
      ? list.map(function (z) { return z.zone.name; }).join(' / ')
      : '等待 MQTT 推送';

    el.kpiAbnormal.innerHTML = abnormal.length + '<span class="unit">个</span>';
    el.kpiAbnormalSub.textContent = abnormal.length
      ? abnormal.map(function (z) { return z.zone.name + ' · ' + z.levelInfo.label; }).join('；')
      : (list.length ? '全部区域状态正常' : '按本地重算的 status 统计');

    var avgPm = list.length
      ? list.reduce(function (s, z) { return s + z.pm25; }, 0) / list.length
      : null;
    el.kpiAvgPm.innerHTML = (avgPm === null ? '–' : fmtNum(avgPm)) +
                            (avgPm === null ? '' : '<span class="unit">μg/m³</span>');

    if (state.focus) {
      el.kpiFocus.textContent = state.focus.name;
      el.kpiFocusSub.textContent = LEVELS[state.focus.level].label + ' · ' +
                                   triggerText(state.zones[state.focus.zoneId]);
      el.focusNote.textContent = '重点告警区域：' + state.focus.name + ' · ' +
                                 LEVELS[state.focus.level].label;
    } else {
      el.kpiFocus.textContent = list.length ? '无' : '–';
      el.kpiFocusSub.textContent = list.length ? '全部区域状态正常' : '按告警级别排序';
      el.focusNote.textContent = list.length
        ? '全部区域状态正常'
        : '每张卡片展示 zoneid / pm25 / co2 / crowdLevel / status / time 六项数据';
    }
  }

  /* ---------- 5.3 区域卡片：每张展示全部 6 项数据 ---------- */

  function renderZones(state) {
    var html = '';

    for (var i = 0; i < ZONES.length; i++) {
      var z = ZONES[i];
      var d = state.zones[z.id];
      var idle = !d;
      var lv = idle ? { key: 'idle', label: '等待数据', glyph: '○', hex: '#898781' } : d.levelInfo;
      var isFocus = !idle && state.focusZoneId === z.id;
      // 刷新后从本地存储回灌的读数：正常渲染，但打标记并降低饱和度，
      // 免得把几小时前的旧值当成实时数据看
      var isCached = !idle && !!d.cached;
      // E2：语音指令选中的区域（与「优先关注」无关，两者可以同时出现）
      var isVoice = E2.voiceTarget === z.id;

      html += '<article class="zone-card' + (idle ? ' is-idle' : '') + (isFocus ? ' is-focus' : '') +
              (isCached ? ' is-cached' : '') + (isVoice ? ' is-voice' : '') + '"' +
              ' data-zone="' + esc(z.id) + '"' +
              ' style="--zone-color:' + z.color + ';--focus-color:' + lv.hex + '"' +
              ' aria-label="' + esc(z.name) + ' 监测数据">';

      // ① zoneid：区域身份色点 + 区域名称 + 区域编号
      html += '<div class="zone-head">' +
                '<div class="zone-id">' +
                  '<span class="zone-dot" aria-hidden="true"></span>' +
                  '<div>' +
                    '<p class="zone-name">' + esc(z.name) + '</p>' +
                    '<p class="zone-code">' + esc(z.id) + '</p>' +
                  '</div>' +
                '</div>' +
              // ⑤ status：本地重算的状态徽章（图标 + 文字 + 颜色三重编码）
                '<span class="badge" data-level="' + lv.key + '">' +
                  '<span class="badge-glyph" aria-hidden="true">' + lv.glyph + '</span>' + lv.label +
                '</span>' +
              '</div>';

      // 状态行：三张卡片都渲染同一行，指标行才能水平对齐
      var flag = idle ? '等待该区域上报数据'
               : (triggerText(d) || '各项指标在阈值内');
      html += '<p class="zone-flag">' +
                (isVoice ? '<span class="voice-pill">语音选中</span>' : '') +
                (isFocus ? '<span class="focus-pill">重点告警区域</span>' : '') +
                (isCached ? '<span class="cached-pill" title="刷新前保存在本地的读数，' +
                            '等待 MQTT 推送新数据">本地缓存</span>' : '') +
                '<span class="flag-text">' + esc(flag) + '</span>' +
              '</p>';

      // ② pm25  ③ co2  ④ crowdLevel
      html += '<div class="zone-metrics">' +
                metricNum('pm25', idle ? null : d.pm25, 'μg/m³') +
                metricNum('co2', idle ? null : d.co2, 'ppm') +
                metricCrowd(idle ? null : d.crowdLevel) +
              '</div>';

      // ⑥ time：采样时间（卡片尾部同时标注收到时间，便于判断数据新鲜度）
      // 缓存读数可能跨天，只显示时分秒会有歧义，所以额外带上月日
      var timeText = idle ? '--:--:--'
                   : (isCached ? d.stampFull.slice(5) : d.timeShort);

      html += '<div class="zone-foot">' +
                '<p class="zone-time">采样时间 <b title="' +
                  esc(idle ? '' : d.stampFull) + '">' + esc(timeText) + '</b></p>' +
                '<p class="zone-time">综合负载 <b>' +
                  (idle ? '–' : Math.round(d.load * 100) + '%') + '</b></p>' +
              '</div>';

      html += '</article>';
    }

    el.zoneGrid.innerHTML = html;
  }

  function metricNum(label, value, unit) {
    return '<div class="metric">' +
             '<p class="metric-label">' + label + '</p>' +
             '<p class="metric-value">' + fmtNum(value) +
               '<span class="metric-unit">' + unit + '</span></p>' +
           '</div>';
  }

  /* 人流等级：主值显示中文档位，副值显示报文里的原始取值 0/1/2 */
  function metricCrowd(code) {
    var crowd = code === null ? null : crowdInfo(code);
    var html = '<div class="metric">' +
                 '<p class="metric-label">crowdLevel</p>' +
                 '<p class="metric-value metric-value--text">' + (crowd ? crowd.label : '–') +
                   '<span class="metric-unit">' + (crowd ? 'Lv.' + code : '') + '</span></p>';
    if (crowd) {
      html += '<div class="meter" style="--meter-color:' + crowd.hex + '" role="presentation">' +
                '<div class="meter-fill" style="width:' + crowd.pct + '%;background:' + crowd.hex + '"></div>' +
              '</div>';
    }
    return html + '</div>';
  }

  /* ---------- 5.4 指标热力分布 ---------- */

  function renderHeat(state) {
    var rows = '';

    for (var i = 0; i < ZONES.length; i++) {
      var z = ZONES[i];
      var d = state.zones[z.id];
      var tds;

      if (!d) {
        // 未收到数据：整行中性占位，不参与色阶
        tds = new Array(4 + 1).join(
          '<td class="heat-cell" data-empty="1">–<span class="heat-unit">等待数据</span></td>');
      } else {
        var cells = [
          { load: normLoad('pm25', d.pm25),        text: d.pm25,                    unit: 'μg/m³' },
          { load: normLoad('co2', d.co2),          text: d.co2,                     unit: 'ppm' },
          { load: normLoad('crowd', d.crowdLevel), text: crowdInfo(d.crowdLevel).label, unit: 'Lv.' + d.crowdLevel },
          { load: d.load,                          text: Math.round(d.load * 100),  unit: '%' }
        ];
        tds = cells.map(function (c) {
          var bin = Math.min(SEQ_BINS - 1, Math.floor(c.load * SEQ_BINS));
          return '<td class="heat-cell" data-bin="' + bin + '" title="归一化负载 ' +
                 Math.round(c.load * 100) + '%">' + esc(c.text) +
                 '<span class="heat-unit">' + esc(c.unit) + '</span></td>';
        }).join('');
      }

      rows += '<tr>' +
                '<th scope="row" class="heat-rowhead">' +
                  '<span class="zone-dot" style="background:' + z.color + '" aria-hidden="true"></span>' +
                  esc(z.name) +
                  '<span class="zone-code">' + esc(z.id) + '</span>' +
                '</th>' + tds +
              '</tr>';
    }

    el.heatBody.innerHTML = rows;

    if (!el.heatLegend.dataset.ready) {
      el.heatLegend.innerHTML =
        '<span>低</span><span class="ramp" aria-hidden="true">' +
        new Array(SEQ_BINS + 1).join('<i></i>') + '</span><span>高</span>' +
        '<span>归一化负载 0–100%</span>';
      el.heatLegend.dataset.ready = '1';
    }
  }

  /* ---------- 5.5 趋势曲线（Chart.js）---------- */

  /* 端点直接标签：数值写实、文字用油墨色，身份由旁边的色点承担。
     标签画在各条线自己的末端（各区域上报节奏不同，需要分别定位），
     文字带表面色描边，即使压在线条上也清晰可读。 */
  var endLabelPlugin = {
    id: 'endLabels',
    afterDatasetsDraw: function (c) {
      var area = c.chartArea;
      var ctx = c.ctx;
      var boundRight = c.width - 4;
      var items = [];

      for (var i = 0; i < c.data.datasets.length; i++) {
        var meta = c.getDatasetMeta(i);
        if (meta.hidden || !meta.data.length) continue;

        // 从后往前找该区域最后一个有效采样点（中间可能有空档）
        var data = c.data.datasets[i].data;
        var idx = -1;
        for (var j = data.length - 1; j >= 0; j--) {
          if (data[j] !== null && data[j] !== undefined) { idx = j; break; }
        }
        if (idx < 0 || !meta.data[idx]) continue;

        items.push({
          x: meta.data[idx].x,
          origY: meta.data[idx].y,
          y: meta.data[idx].y,
          text: Math.round(data[idx]) + '',
          color: c.data.datasets[i].borderColor
        });
      }
      if (!items.length) return;

      // 标签互相靠得太近时顺势推开，并用引线保持与数据点的连接
      items.sort(function (a, b) { return a.y - b.y; });
      var GAP = 15;
      for (var k = 1; k < items.length; k++) {
        if (items[k].y - items[k - 1].y < GAP) items[k].y = items[k - 1].y + GAP;
      }
      var overflow = items[items.length - 1].y - (area.bottom - 4);
      if (overflow > 0) {
        for (var m = 0; m < items.length; m++) items[m].y -= overflow;
      }

      ctx.save();
      ctx.font = '600 12px system-ui, -apple-system, "Segoe UI", sans-serif';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';

      for (var n = 0; n < items.length; n++) {
        var it = items[n];
        var w = ctx.measureText(it.text).width;

        // 优先放在数据点右侧；右边界放不下就翻到左侧
        var rightSide = (it.x + 12 + w) <= boundRight;
        var lx = rightSide ? it.x + 12 : it.x - 12 - w;

        // 标签被垂直推开时补一条引线，避免与数据点失去联系
        if (Math.abs(it.y - it.origY) > 2) {
          ctx.beginPath();
          ctx.strokeStyle = it.color;
          ctx.globalAlpha = 0.45;
          ctx.lineWidth = 1;
          ctx.moveTo(it.x + (rightSide ? 6 : -6), it.origY);
          ctx.lineTo(rightSide ? lx - 4 : lx + w + 4, it.y);
          ctx.stroke();
          ctx.globalAlpha = 1;
        }

        // 端点标记：2px 表面色描环，保证与线交叠时仍清晰
        ctx.beginPath();
        ctx.arc(it.x, it.origY, 3.5, 0, Math.PI * 2);
        ctx.fillStyle = it.color;
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = THEME['--surface'];
        ctx.stroke();

        // 端点数值标签（油墨色文字，不穿数据色）
        ctx.lineWidth = 3;
        ctx.strokeStyle = THEME['--surface'];
        ctx.strokeText(it.text, lx, it.y);
        ctx.fillStyle = THEME['--ink-1'];
        ctx.fillText(it.text, lx, it.y);
      }
      ctx.restore();
    }
  };

  /* 阈值参考线：75 轻度污染 / 150 重度污染 */
  var thresholdPlugin = {
    id: 'thresholds',
    beforeDatasetsDraw: function (c) {
      var area = c.chartArea;
      var y = c.scales.y;
      var ctx = c.ctx;
      var marks = [
        { v: 75,  color: 'rgba(236,131,90,.75)', text: '轻度污染 75' },
        { v: 150, color: 'rgba(208,59,59,.75)',  text: '重度污染 150' }
      ];

      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.lineWidth = 1;
      ctx.font = '500 11px system-ui, sans-serif';
      ctx.textBaseline = 'bottom';

      for (var i = 0; i < marks.length; i++) {
        var py = y.getPixelForValue(marks[i].v);
        if (py < area.top || py > area.bottom) continue;

        ctx.strokeStyle = marks[i].color;
        ctx.beginPath();
        ctx.moveTo(area.left, py);
        ctx.lineTo(area.right, py);
        ctx.stroke();

        ctx.setLineDash([]);
        ctx.fillStyle = THEME['--ink-muted'];
        ctx.textAlign = 'left';
        ctx.fillText(marks[i].text, area.left + 4, py - 3);
        ctx.setLineDash([5, 4]);
      }
      ctx.restore();
    }
  };

  function initChart() {
    if (!el.trendCanvas || typeof window.Chart === 'undefined') {
      el.chartWrap.innerHTML =
        '<p class="empty-state">图表库（Chart.js CDN）未能加载，请检查网络后刷新。<br>' +
        '可切换到「表格视图」查看 PM2.5 数据。</p>';
      return null;
    }

    var surface = THEME['--surface'];

    return new window.Chart(el.trendCanvas.getContext('2d'), {
      type: 'line',
      data: {
        labels: [],
        datasets: ZONES.map(function (z) {
          return {
            label: z.name,
            data: [],
            borderColor: z.color,
            backgroundColor: z.color,
            borderWidth: 2,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBorderWidth: 2,
            pointHoverBorderColor: surface,
            pointHoverBackgroundColor: z.color,
            spanGaps: true          // 该区域没有上报的采样点直接跨过，不伪造水平线段
          };
        })
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 320 },
        interaction: { mode: 'index', intersect: false },
        layout: { padding: { right: 46, top: 6 } },
        scales: {
          x: {
            grid: { display: false },
            border: { color: THEME['--axis'] },
            ticks: { color: THEME['--ink-muted'], font: { size: 11 }, maxTicksLimit: 7, maxRotation: 0, autoSkip: true }
          },
          y: {
            beginAtZero: true,
            grid: { color: THEME['--grid'], drawTicks: false },
            border: { display: false },
            title: { display: true, text: 'pm25 (μg/m³)', color: THEME['--ink-muted'], font: { size: 11 }, padding: { bottom: 6 } },
            ticks: { color: THEME['--ink-muted'], font: { size: 11 }, padding: 8, stepSize: 50 }
          }
        },
        plugins: {
          legend: {
            position: 'top',
            align: 'end',
            labels: {
              usePointStyle: true, pointStyle: 'rectRounded',
              boxWidth: 9, boxHeight: 9, boxPadding: 5,
              color: THEME['--ink-2'], font: { size: 12 }
            }
          },
          tooltip: {
            backgroundColor: surface,
            titleColor: THEME['--ink-1'],
            bodyColor: THEME['--ink-2'],
            borderColor: 'rgba(11,11,11,.12)',
            borderWidth: 1,
            padding: 10,
            cornerRadius: 8,
            boxPadding: 5,
            usePointStyle: true,
            titleFont: { size: 12, weight: '600' },
            bodyFont: { size: 12 },
            callbacks: {
              title: function (items) { return '采样时间 ' + items[0].label; },
              label: function (item) {
                return '  ' + item.dataset.label + '  ' + Math.round(item.parsed.y) + ' μg/m³';
              }
            }
          }
        }
      },
      plugins: [thresholdPlugin, endLabelPlugin]
    });
  }

  function renderChart(state) {
    if (!chart) return;

    chart.data.labels = state.history.map(function (p) { return p.label; });
    for (var i = 0; i < ZONES.length; i++) {
      var id = ZONES[i].id;
      chart.data.datasets[i].data = state.history.map(function (p) { return p.values[id]; });
    }
    chart.update('none');

    el.chartEmpty.hidden = state.history.length > 0;
  }

  /* 趋势图的表格视图（无障碍等价视图） */
  function renderTrendTable(state) {
    if (currentView !== 'table') return;

    el.trendTableHead.innerHTML = '<th scope="col">采样时间</th>' +
      ZONES.map(function (z) { return '<th scope="col">' + esc(z.name) + '</th>'; }).join('');

    var rows = state.history.slice(-14).reverse().map(function (p) {
      return '<tr><td>' + esc(p.label) + '</td>' +
        ZONES.map(function (z) {
          var v = p.values[z.id];
          return '<td>' + (v === null || v === undefined ? '–' : Math.round(v)) + '</td>';
        }).join('') + '</tr>';
    }).join('');

    el.trendTableBody.innerHTML = rows ||
      '<tr><td colspan="4" style="color:var(--ink-muted)">暂无采样数据，等待 MQTT 推送</td></tr>';
  }

  /* ---------- 5.6 事件状态列表（含正常读数） ---------- */

  /* ---------- 5.3 持续风险与优先关注 ---------- */

  function renderPriority(state) {
    var pri = state.priority || { rows: [], winner: null };
    var win = pri.winner;

    // 胜出区域整块面板加个标记色，扫一眼就知道该看哪儿
    el.priorityPanel.dataset.focus = win ? 'yes' : 'no';

    if (!pri.rows.length) {
      el.priorityFocus.innerHTML = '<p class="priority-idle">等待 MQTT 推送后开始打分…</p>';
      el.priorityEmpty.hidden = false;
      el.priorityEmpty.textContent = '尚未收到任何区域的读数。';
      el.priorityScoreBody.innerHTML = '';
      return;
    }

    if (!win) {
      el.priorityFocus.innerHTML =
        '<p class="priority-none">暂无优先关注</p>' +
        '<p class="priority-none-sub">各区域环境正常、人流稀疏，总分均为 0。</p>';
    } else {
      el.priorityFocus.innerHTML =
        '<div class="priority-zone">' +
          '<span class="zone-dot" style="background:' + win.color + '" aria-hidden="true"></span>' +
          esc(win.name) +
        '</div>' +
        '<div class="priority-total">' + win.total +
          '<span class="unit">分</span></div>' +
        '<div class="priority-split">' +
          '<span>环境异常分 <b>' + win.env + '</b></span>' +
          '<span>人流分 <b>' + win.crowd + '</b></span>' +
        '</div>' +
        '<p class="priority-reason">' + esc(win.reason) + '</p>' +
        '<p class="priority-verdict" id="priorityVerdict">' + esc(win.verdict || '') + '</p>';
    }

    el.priorityScoreBody.innerHTML = pri.rows.map(function (r) {
      var isWin = win && r.zoneId === win.zoneId;
      return '<tr data-win="' + (isWin ? '1' : '0') + '">' +
               '<td><span class="cell-zone">' +
                 '<span class="zone-dot" style="background:' + r.color + '" aria-hidden="true"></span>' +
                 esc(r.name) + '</span></td>' +
               '<td>' + r.env + '</td>' +
               '<td>' + r.crowd + ' <span class="unit-label">' + esc(r.crowdLabel) + '</span></td>' +
               '<td><b>' + r.total + '</b></td>' +
               '<td class="cell-reason">' + esc(r.reason) + '</td>' +
             '</tr>';
    }).join('');

    el.priorityEmpty.hidden = true;
  }

  /* ---------------------------------------------------------------------------
   * 5.9 D3 干预事件卡片
   *   每栋楼一张独立卡片（对应 3D 端的悬浮告警卡片），干预动作全在卡片内用文字展示。
   *   卡片每次渲染都是整块重建，所以勾选状态先存在 pendingActions 里再回填——
   *   否则每收到一条报文就重绘一次，用户勾了一半的选项会被清空。
   * ------------------------------------------------------------------------ */
  var pendingActions = {};   // zoneId -> 已勾选、尚未提交的干预动作

  /* 实时监测数据一行：异常类型与当前读数，OPEN 与 HANDLING 都要看 */
  function evLiveHtml(state, zoneId) {
    var z = state.zones[zoneId];
    if (!z) return '<p class="event-live">等待 ' + esc(zoneId) + ' 的读数…</p>';
    return '<p class="event-live">' +
             '<span>PM2.5 <b>' + z.pm25 + '</b> μg/m³</span>' +
             '<span>CO₂ <b>' + z.co2 + '</b> ppm</span>' +
             '<span>人流 <b>' + esc(crowdInfo(z.crowdLevel).label) + '</b> ' + z.crowdLevel + ' 级</span>' +
             '<span class="event-live-level">' + esc(z.levelInfo.label) + '</span>' +
             '<span class="event-live-time">' + esc(z.timeFull) + '</span>' +
           '</p>';
  }

  function evCard(state, ev) {
    var live = evLiveHtml(state, ev.zoneId);
    var meta = '<dl class="event-meta">' +
        '<div><dt>异常类型</dt><dd>' + esc(ev.type) + '</dd></div>' +
        '<div><dt>事件开始</dt><dd>' + esc(ev.startedAt) + '</dd></div>' +
        '<div><dt>优先关注理由</dt><dd>' + esc(ev.priorityReason) + '</dd></div>' +
      '</dl>';

    var body = '';

    if (ev.state === EV_OPEN) {
      /* ---- OPEN 待处理：干预动作选择器 + 执行按钮，唯一的可交互状态 ---- */
      var list = EV_ACTIONS[ev.actionKey] || [];
      var picked = pendingActions[ev.zoneId] || [];
      body = live + meta +
        '<fieldset class="event-actions">' +
          '<legend>选择干预动作（可多选多条）</legend>' +
          list.map(function (a) {
            return '<label class="event-action">' +
                     '<input type="checkbox" value="' + esc(a) + '"' +
                       (picked.indexOf(a) >= 0 ? ' checked' : '') + '>' +
                     '<span>' + esc(a) + '</span></label>';
          }).join('') +
        '</fieldset>' +
        '<button type="button" class="event-submit" data-zone="' + esc(ev.zoneId) + '"' +
          (picked.length ? '' : ' disabled') + '>执行干预</button>';
    } else if (ev.state === EV_HANDLING) {
      /* ---- HANDLING 处理中：只读。恢复只能等新监测数据，页面上没有手动恢复入口 ---- */
      body = live +
        '<div class="event-done">' +
          '<h4>已执行干预动作</h4>' +
          ev.userActions.map(function (u) {
            return '<div class="event-done-row">' +
                     '<span class="event-done-time">' + esc(u.at) + '</span>' +
                     '<span class="event-done-actor">' + esc(u.actor) + '</span>' +
                     '<span class="event-done-list">' + esc(u.actions.join(' / ')) + '</span>' +
                   '</div>';
          }).join('') +
        '</div>' +
        meta +
        '<p class="event-hint">等待新监测数据自动判定恢复（1 条正常数据即恢复），不可手动恢复。</p>' +
        '<p class="event-outcome">' + esc(ev.outcome) +
          (ev.manualReview ? ' · <b class="event-review">已标记人工复核</b>' : '') + '</p>';
    } else {
      /* ---- RECOVERED 已恢复：卡片自动关闭（只留一条只读回执） ---- */
      body = '<dl class="event-meta">' +
          '<div><dt>恢复时间</dt><dd>' + esc(ev.recoveredAt || '—') + '</dd></div>' +
          '<div><dt>最终结果</dt><dd>' + esc(ev.outcome) + '</dd></div>' +
          '<div><dt>干预动作</dt><dd>' +
            esc(ev.userActions.map(function (u) { return u.actions.join(' / '); }).join('；') || '—') +
          '</dd></div>' +
        '</dl>' +
        '<p class="event-hint">事件已恢复，卡片自动关闭。</p>';
    }

    return '<article class="event-card" data-state="' + ev.state + '" data-zone="' + esc(ev.zoneId) + '">' +
             '<header class="event-card-head">' +
               '<span class="event-state">' + esc(EV_LABEL[ev.state]) + '</span>' +
               '<span class="event-zone">' +
                 '<span class="zone-dot" style="background:' + esc(zoneColor(ev.zoneId)) + '" aria-hidden="true"></span>' +
                 esc(ev.zoneName) + '</span>' +
             '</header>' + body + '</article>';
  }

  function zoneColor(zoneId) {
    var z = findZone(zoneId);
    return z ? z.color : '#898781';
  }

  function renderEvents(state) {
    if (!el.eventGrid) return;

    /* 只展示「当前这一批」：三个区域各自的当前事件，外加最近恢复的收尾回执。
       更早的历史事件是存档，不占大屏版面。 */
    var cards = [];
    for (var i = 0; i < ZONES.length; i++) {
      var ev = state.activeEvents[ZONES[i].id];
      if (ev) cards.push(ev);
    }
    if (!cards.length) {
      el.eventGrid.innerHTML = '';
      el.eventEmpty.hidden = false;
      el.eventEmpty.textContent = '暂无干预事件——各区域指标在阈值内。';
      return;
    }

    el.eventGrid.innerHTML = cards.map(function (ev) { return evCard(state, ev); }).join('');
    el.eventEmpty.hidden = true;
  }

  function renderAlerts(state) {
    var rows = state.alerts.map(function (a) {
      var lv = LEVELS[a.level];
      // data-level 挂到行上：正常行由样式压暗，一眼扫过去仍然是告警最显眼
      return '<tr data-level="' + lv.key + '">' +
               '<td title="' + esc(a.timeFull) + '">' + esc(a.timeShort) + '</td>' +
               '<td><span class="cell-zone">' +
                 '<span class="zone-dot" style="background:' + a.zoneColor + '" aria-hidden="true"></span>' +
                 esc(a.zoneName) + '</span></td>' +
               '<td>' + esc(a.type) + '</td>' +
               '<td><span class="badge" data-level="' + lv.key + '">' +
                 '<span class="badge-glyph" aria-hidden="true">' + lv.glyph + '</span>' + lv.label +
               '</span></td>' +
               '<td>' + esc(a.trigger) + '</td>' +
             '</tr>';
    }).join('');

    el.alertBody.innerHTML = rows;
    el.alertEmpty.hidden = state.alerts.length > 0;
    el.alertCount.textContent = state.alerts.length
      ? '最近 ' + state.alerts.length + ' 条 · 上限 ' + CONFIG.maxAlerts + ' 条'
      : '暂无记录';
  }

  /* ---------- 5.7 统一渲染入口 ---------- */

  function render(state) {
    renderTopbar(state);
    renderKpi(state);
    renderPriority(state);
    renderEvents(state);
    renderZones(state);
    renderHeat(state);
    renderChart(state);
    renderTrendTable(state);
    renderAlerts(state);
  }

  /* ===========================================================================
   * 6. 交互
   * ======================================================================== */

  /* ---------------------------------------------------------------------------
   * 6.5 导出 CSV：把 historyRecords 写成 history.csv 交给浏览器下载
   * ------------------------------------------------------------------------ */

  /* 表头严格就是这 6 个列名；行内取值也按这个顺序，保证列与表头一一对应 */
  var CSV_COLUMNS = ['time', 'zone', 'pm25', 'co2', 'crowdLevel', 'status'];

  /* 按 RFC 4180 转义：值里出现逗号 / 双引号 / 换行时用双引号包裹，内部双引号翻倍 */
  function csvCell(v) {
    if (v === null || v === undefined) return '';
    var s = String(v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  var csvUrl = null;

  function exportCsv() {
    var lines = [CSV_COLUMNS.join(',')];
    for (var i = 0; i < historyRecords.length; i++) {
      var rec = historyRecords[i];
      lines.push(CSV_COLUMNS.map(function (key) { return csvCell(rec[key]); }).join(','));
    }

    /* 开头写 UTF-8 BOM：status 列是中文（正常 / 轻度污染 …），
       没有 BOM 的话 Excel / WPS 双击打开会按 ANSI 代码页解码，中文全成乱码。
       列名与列顺序不受影响，BOM 只是文件最前面 3 个不可见字节。
       行尾用 CRLF，符合 RFC 4180。 */
    var blob = new Blob(['\uFEFF' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' });
    if (csvUrl) URL.revokeObjectURL(csvUrl);
    csvUrl = URL.createObjectURL(blob);

    var a = document.createElement('a');
    a.href = csvUrl;
    a.download = 'history.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    /* 不能立刻 revoke：部分浏览器要等下载真正启动后才去读这个 URL。
       延迟回收，同时保证连点几次也不会泄漏 objectURL。 */
    setTimeout(function () {
      if (csvUrl) { URL.revokeObjectURL(csvUrl); csvUrl = null; }
    }, 1000);

    console.info('[AirGuard] 已导出 history.csv，共 ' + historyRecords.length + ' 条记录');
  }

  /* 清空屏幕上的记录：historyRecords（CSV 存档）与 state.alerts（事件列表）一起清，
     两者都是「记录」，屏幕上也要跟着消失。
     区域卡片与趋势曲线不动——那是当前这一秒的实时读数，不是记录。

     没有本地存储可删：四端一律不落盘，清的就是内存里的这两份。 */
  function clearHistory() {
    var alerts = Store.state.alerts;
    if (!window.confirm('确定清空屏幕上的全部记录？\n\n' +
                        '将清掉已收到的 ' + historyRecords.length + ' 条历史记录，' +
                        '以及事件列表中的 ' + alerts.length + ' 条。\n' +
                        '此操作不可撤销。')) {
      return;
    }

    historyRecords.length = 0;
    alerts.length = 0;

    render(Store.state);       // 事件列表重绘为空
    console.info('[AirGuard] 已清空记录（历史 + 事件列表），区域卡片与趋势曲线不受影响');
  }

  function bindEvents() {
    var exportBtn = $('exportCsv');
    if (exportBtn) exportBtn.addEventListener('click', exportCsv);

    var clearBtn = $('clearHistory');
    if (clearBtn) clearBtn.addEventListener('click', clearHistory);

    var segBtns = document.querySelectorAll('.seg-btn');
    Array.prototype.forEach.call(segBtns, function (btn) {
      btn.addEventListener('click', function () {
        currentView = btn.dataset.view;
        Array.prototype.forEach.call(segBtns, function (b) {
          b.classList.toggle('is-active', b === btn);
        });
        el.chartWrap.hidden = currentView !== 'chart';
        el.chartTableWrap.hidden = currentView !== 'table';
        if (currentView === 'table') renderTrendTable(Store.state);
      });
    });

    /* ---- D3 干预卡片：勾选与提交 ----
       卡片每次渲染都是整块重建的，所以监听挂在容器上做事件委托，
       重建不会把监听一起丢掉（挂在按钮上就会）。 */
    if (el.eventGrid) {
      el.eventGrid.addEventListener('change', function (e) {
        var cb = e.target;
        if (!cb || cb.type !== 'checkbox') return;
        var card = cb.closest('.event-card');
        if (!card) return;
        var zoneId = card.dataset.zone;
        var set = pendingActions[zoneId] || (pendingActions[zoneId] = []);
        var i = set.indexOf(cb.value);
        if (cb.checked && i < 0) set.push(cb.value);
        if (!cb.checked && i >= 0) set.splice(i, 1);
        /* 一个都没勾就禁用按钮：空动作会被状态机拒绝，不如让按钮先点不动 */
        var btn = card.querySelector('.event-submit');
        if (btn) btn.disabled = set.length === 0;
      });

      el.eventGrid.addEventListener('click', function (e) {
        var btn = e.target.closest ? e.target.closest('.event-submit') : null;
        if (!btn) return;
        var zoneId = btn.dataset.zone;
        var actions = (pendingActions[zoneId] || []).slice();
        /* 状态不是 OPEN 时 intervene 返回 null —— 这条路径天然挡住了
           「已处理中 / 已恢复还能再点一次干预」 */
        var ev = Store.intervene(zoneId, actions, { actor: 'web' });
        if (!ev) return;
        pendingActions[zoneId] = [];
        Mqtt.publishIntervention(ev, actions);
      });
    }

    /* ---- E2：语音 / 记录现场 / 朗读结论 ---- */
    if (el.micBtn) el.micBtn.addEventListener('click', toggleListening);
    if (el.photoBtn) el.photoBtn.addEventListener('click', openCamera);
    if (el.speakBtn) el.speakBtn.addEventListener('click', function () { speakConclusion(null); });

    if (el.cmdInput) {
      /* 文字指令与语音指令走同一条解析路径：语音不可用时（比如浏览器不支持
         语音识别、或机器连不上识别服务）功能仍然完整可演示 */
      el.cmdInput.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        var text = el.cmdInput.value.trim();
        if (!text) return;
        el.cmdInput.value = '';
        runCommand(text, 'text');
      });
      el.cmdInput.addEventListener('click', function (e) { e.stopPropagation(); });
    }

    if (el.camShoot) el.camShoot.addEventListener('click', shootPhoto);
    if (el.camCancel) el.camCancel.addEventListener('click', closeCamera);
    if (el.camPick) {
      el.camPick.addEventListener('click', function () { el.camFile.click(); });
    }
    if (el.camFile) {
      el.camFile.addEventListener('change', function () {
        var file = el.camFile.files && el.camFile.files[0];
        el.camFile.value = '';
        if (!file) return;
        var reader = new FileReader();
        reader.onload = function () {
          addPhoto(String(reader.result), E2.camZoneId);
          e2Toast('已记录现场照片（' + zoneLabel(E2.camZoneId) + '）');
          closeCamera();
        };
        reader.onerror = function () { setStatus('这张图片读不出来，换一张试试', true); };
        reader.readAsDataURL(file);
      });
    }
    if (el.camOverlay) {
      /* 点遮罩空白处关闭；点浮层内容不关 */
      el.camOverlay.addEventListener('click', function (e) {
        if (e.target === el.camOverlay) closeCamera();
      });
    }
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && el.camOverlay && !el.camOverlay.hidden) closeCamera();
    });
  }

  /* ===========================================================================
   * 6.6 E2：语音指令（ASR）/ 记录现场（拍照）/ 朗读结论（TTS）
   *
   *   三条语音指令：
   *     查看宿舍区zone-n / 查看教学区zone-s / 查看食堂区zone-w → 高亮该区域卡片
   *     记录现场                                              → 拍一张现场照片
   *     朗读结论                                              → 播报该区域实时状态
   *
   *   照片与语音全部只活在内存里：本页不落盘、不上传、不发往公网，刷新即清空（与全项目一致）。
   *   语音文字与文字输入框走同一条指令解析：解析器是纯函数，控制台可直接调。
   * ======================================================================== */

  var E2 = {
    voiceTarget: null,   // 语音/文字指令选中的区域，null = 还没选
    photos: [],          // 现场照片，最新在前
    camZoneId: null,     // 本次拍照绑定的区域
    stream: null,        // getUserMedia 的媒体流，关浮层时必须停掉
    rec: null,           // SpeechRecognition 实例
    listening: false,
    PHOTO_MAX: 24        // 内存里最多留 24 张，超出丢最旧的
  };

  var photoSeq = 0;
  var SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition || null;

  /* 指令里的区域说法：中文名、区域编号，以及语音识别常把 zone-n 听成的 zonen */
  var E2_ZONE_WORDS = [
    { id: 'zone-n', words: ['宿舍区', '宿舍', 'zone-n', 'zonen'] },
    { id: 'zone-s', words: ['教学区', '教学楼', 'zone-s', 'zones'] },
    { id: 'zone-w', words: ['食堂区', '食堂', 'zone-w', 'zonew'] }
  ];

  /* ---------------------------------------------------------------------------
   * 指令解析（纯函数）：返回 { action, zoneId }
   *   action：view（查看区域）/ photo（记录现场）/ speak（朗读结论）/ unknown
   * 先认区域、再认动作：这样「朗读食堂区的结论」也能带上区域。
   * ------------------------------------------------------------------------ */
  function parseCommand(text) {
    var t = String(text == null ? '' : text)
              .toLowerCase()
              .replace(/[\s,，。.、！!？?]/g, '');

    var zoneId = null;
    for (var i = 0; i < E2_ZONE_WORDS.length && !zoneId; i++) {
      for (var j = 0; j < E2_ZONE_WORDS[i].words.length; j++) {
        if (t.indexOf(E2_ZONE_WORDS[i].words[j]) >= 0) {
          zoneId = E2_ZONE_WORDS[i].id;
          break;
        }
      }
    }

    /* 认动作前先把区域词剔掉：「记录食堂区现场」里的区域名会把「记录现场」切开 */
    var rest = t;
    for (var m = 0; m < E2_ZONE_WORDS.length; m++) {
      for (var n = 0; n < E2_ZONE_WORDS[m].words.length; n++) {
        rest = rest.split(E2_ZONE_WORDS[m].words[n]).join('');
      }
    }

    var action = 'unknown';
    if (/记录现场|拍照|拍摄|拍张|拍一张|照片|留证|录像/.test(rest)) action = 'photo';
    else if (/朗读|播报|读一下|念一下|结论/.test(rest)) action = 'speak';
    else if (zoneId) action = 'view';
    else if (/查看|查一下|看|切换|定位|聚焦/.test(rest)) action = 'view';

    return { action: action, zoneId: zoneId };
  }

  function zoneLabel(zoneId) {
    var z = findZone(zoneId);
    return z ? z.name + z.id : String(zoneId || '');
  }

  /* 指令没点名区域时用哪个区域：优先「持续风险与优先关注」算出来的那个，
     再退到重点关注区域；都没有（三区全正常）就让调用方提示先选区域。 */
  function resolveZoneId() {
    if (E2.voiceTarget) return E2.voiceTarget;
    var p = Store.state.priority;
    if (p && p.winner && p.winner.zoneId) return p.winner.zoneId;
    return Store.state.focusZoneId || null;
  }

  /* 该区域当前绑定的告警事件：优先 D3 事件，其次事件列表里该区域最近一条 */
  function currentEventOf(zoneId) {
    var ev = Store.state.activeEvents[zoneId];
    if (ev) {
      return {
        id: ev.event_id,
        type: ev.type,
        state: ev.state,
        text: ev.type + ' · ' + (EV_LABEL[ev.state] || ev.state)
      };
    }
    var alerts = Store.state.alerts;
    for (var i = 0; i < alerts.length; i++) {
      if (alerts[i].zoneId === zoneId) {
        return {
          id: alerts[i].id,
          type: alerts[i].type,
          state: null,
          text: alerts[i].type + ' · ' + alerts[i].timeShort + ' 状态流水'
        };
      }
    }
    return null;   // 该区域还没出过任何事件
  }

  /* ---------------------------------------------------------------------------
   * 反馈：状态行 + 底部提示条 + 可选朗读
   * ------------------------------------------------------------------------ */
  function setStatus(text, isError) {
    if (!el.e2Status) return;
    el.e2Status.textContent = text;
    el.e2Status.style.color = isError ? 'var(--status-critical)' : '';
  }

  var toastEl = null;
  var toastTimer = null;

  function e2Toast(text) {
    if (!toastEl) {
      toastEl = document.createElement('div');
      toastEl.className = 'e2-toast';
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    toastEl.classList.add('is-on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('is-on'); }, 3200);
  }

  function pickZhVoice() {
    if (!window.speechSynthesis) return null;
    var voices = window.speechSynthesis.getVoices() || [];
    for (var i = 0; i < voices.length; i++) {
      if (/^zh/i.test(voices[i].lang)) return voices[i];
    }
    return null;
  }

  function e2Speak(text) {
    if (!window.speechSynthesis) {
      setStatus('当前浏览器不支持语音播报（TTS）', true);
      return;
    }
    try {
      window.speechSynthesis.cancel();     // 连点两次时不要两条声音叠着念
      var u = new SpeechSynthesisUtterance(text);
      u.lang = 'zh-CN';
      u.rate = 1;
      u.pitch = 1;
      var v = pickZhVoice();
      if (v) u.voice = v;
      window.speechSynthesis.speak(u);
    } catch (err) {
      console.warn('[AirGuard] TTS 失败：', err);
      setStatus('语音播报失败：' + err.message, true);
    }
  }

  /* ---------------------------------------------------------------------------
   * ① 查看某区域：高亮区域卡片
   * ------------------------------------------------------------------------ */
  function highlightZone(zoneId) {
    E2.voiceTarget = zoneId;
    renderZones(Store.state);     // 卡片是整块重建的，滚之前要重新取节点
    var card = el.zoneGrid && el.zoneGrid.querySelector('[data-zone="' + zoneId + '"]');
    if (card && card.scrollIntoView) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  /* ---------------------------------------------------------------------------
   * ② 朗读结论：感知维度（crowdLevel）+ 环境维度
   *    crowdLevel 来自 MQTT 报文（simulated 数据），环境等级复用读数里已算好的判定
   * ------------------------------------------------------------------------ */
  function crowdPhrase(code) {
    if (code >= 3) return '严重拥挤，疑似早午晚饭用餐高峰';
    if (code === 2) return '拥挤，疑似课间人流高峰';
    if (code === 1) return '人流正常，环境平稳';
    return '人流稀疏，环境正常';
  }

  function envPhrase(d) {
    var label = zoneLabel(d.zoneId);
    if (d.level === 'critical') return label + '的PM2.5 ' + d.pm25 + '，大于150，重度污染';
    if (d.level === 'warning') return label + '的PM2.5 ' + d.pm25 + '，大于75，轻度污染';
    if (d.level === 'serious') return label + '的CO2 ' + d.co2 + '，大于等于1500，通风不足风险';
    return label + '正常';
  }

  function conclusionText(zoneId) {
    var d = Store.state.zones[zoneId];
    if (!d) return zoneLabel(zoneId) + '暂时没有数据，请等待 MQTT 推送。';
    return zoneLabel(zoneId) + '。感知维度：' + crowdPhrase(d.crowdLevel) +
           '。环境维度：' + envPhrase(d) + '。';
  }

  function speakConclusion(zoneId) {
    var id = zoneId || resolveZoneId();
    if (!id) {
      setStatus('还没有任何区域数据：先语音说「查看食堂区zone-w」，或等 MQTT 推送', true);
      return;
    }
    var text = conclusionText(id);
    setStatus('朗读结论 · ' + text);
    e2Toast('🔊 ' + text);
    e2Speak(text);
  }

  /* ---------------------------------------------------------------------------
   * ③ 记录现场：拍照并绑定 区域 / 时间 / 当前告警事件
   * ------------------------------------------------------------------------ */
  function openCamera() {
    var id = resolveZoneId();
    if (!id) {
      setStatus('还不知道要记录哪个区域：先语音说「查看食堂区zone-w」，或等 MQTT 推送', true);
      return;
    }
    E2.camZoneId = id;

    var ev = currentEventOf(id);
    el.camBind.innerHTML = '绑定区域 <b>' + esc(zoneLabel(id)) + '</b>' +
      (ev ? ' · 告警事件 <b>' + esc(ev.text) + '</b>' : ' · 该区域暂无告警事件');
    el.camNote.textContent = '';
    el.camOverlay.hidden = false;
    startStream();
  }

  function startStream() {
    var md = navigator.mediaDevices;
    if (!md || !md.getUserMedia) {
      el.camNote.textContent = '这个浏览器/打开方式拿不到摄像头，改用【改用本地图片】选一张现场照片。';
      return;
    }
    md.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false })
      .then(function (stream) {
        E2.stream = stream;
        el.camVideo.srcObject = stream;
        el.camNote.textContent = '点【拍照】留证；照片只存在本页内存里。';
      })
      .catch(function (err) {
        var hint = err && err.name === 'NotAllowedError'
          ? '摄像头权限被拒绝。'
          : '摄像头打不开（' + (err && err.name ? err.name : '未知错误') + '）。';
        el.camNote.textContent = hint + '可以用【改用本地图片】选一张现场照片；' +
          '用 http://127.0.0.1 打开本页通常能正常调用摄像头。';
      });
  }

  function closeCamera() {
    if (E2.stream) {
      var tracks = E2.stream.getTracks ? E2.stream.getTracks() : [];
      for (var i = 0; i < tracks.length; i++) tracks[i].stop();   // 不关流摄像头指示灯会一直亮
      E2.stream = null;
    }
    if (el.camVideo) el.camVideo.srcObject = null;
    if (el.camOverlay) el.camOverlay.hidden = true;
  }

  function shootPhoto() {
    var v = el.camVideo, c = el.camCanvas;
    if (!v || !v.videoWidth) {
      el.camNote.textContent = '摄像头画面还没就绪，稍等一下再点【拍照】。';
      return;
    }
    var w = 640;
    var h = Math.max(1, Math.round(v.videoHeight * w / v.videoWidth));
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(v, 0, 0, w, h);

    var zoneId = E2.camZoneId;
    addPhoto(c.toDataURL('image/jpeg', 0.8), zoneId);
    closeCamera();
    e2Toast('已记录现场照片（' + zoneLabel(zoneId) + '）');
  }

  /* 存一条照片记录：zone + 时间 + 当前告警事件 + 拍照那一刻的读数 */
  function addPhoto(dataUrl, zoneId) {
    var z = findZone(zoneId);
    var d = Store.state.zones[zoneId] || null;
    var now = Date.now();

    var photo = {
      id: 'photo-' + (++photoSeq),
      zoneId: zoneId,
      zoneName: z ? z.name : zoneId,
      zoneColor: z ? z.color : '#898781',
      at: fmtStampFull(now),
      timeShort: fmtTime(now),
      dataUrl: dataUrl,
      reading: d ? {
        pm25: d.pm25,
        co2: d.co2,
        crowdLevel: d.crowdLevel,
        levelLabel: d.levelInfo.label
      } : null,
      event: currentEventOf(zoneId)
    };
    E2.photos.unshift(photo);

    if (E2.photos.length > E2.PHOTO_MAX) E2.photos.length = E2.PHOTO_MAX;
    renderPhotos();
    return photo;
  }

  function renderPhotos() {
    if (!el.photoGrid) return;

    el.photoGrid.innerHTML = E2.photos.map(function (p) {
      var evLine = p.event ? esc(p.event.text) : '无告警事件';
      var r = p.reading;
      var readLine = r
        ? 'pm25 ' + r.pm25 + ' / co2 ' + r.co2 + ' / 人流 Lv.' + r.crowdLevel +
          crowdInfo(r.crowdLevel).label + ' / ' + r.levelLabel
        : '拍照时该区域暂无读数';
      var file = '现场_' + p.zoneId + '_' + p.at.replace(/[-: ]/g, '') + '.jpg';

      return '<figure class="photo-card">' +
               '<img src="' + p.dataUrl + '" alt="' + esc(p.zoneName + p.zoneId + ' 现场照片') + '" />' +
               '<figcaption class="photo-meta">' +
                 '<p class="photo-zone">' +
                   '<span class="zone-dot" style="background:' + p.zoneColor + '" aria-hidden="true"></span>' +
                   esc(p.zoneName) + '<span class="zone-code">' + esc(p.zoneId) + '</span>' +
                 '</p>' +
                 '<p class="photo-line">时间 <b>' + esc(p.at) + '</b></p>' +
                 '<p class="photo-line">事件 <b>' + evLine + '</b></p>' +
                 '<p class="photo-line">读数 <b>' + esc(readLine) + '</b></p>' +
                 '<a class="photo-dl" href="' + p.dataUrl + '" download="' + esc(file) + '">下载照片</a>' +
               '</figcaption>' +
             '</figure>';
    }).join('');

    el.photoEmpty.hidden = E2.photos.length > 0;
    if (el.photoCount) {
      el.photoCount.textContent = E2.photos.length
        ? '共 ' + E2.photos.length + ' 张 · 上限 ' + E2.PHOTO_MAX + ' 张（只存内存，刷新即清）'
        : '暂无照片';
    }
  }

  /* ---------------------------------------------------------------------------
   * ④ 语音识别：三条指令的入口
   * ------------------------------------------------------------------------ */
  function toggleListening() {
    if (!SpeechRec) {
      setStatus('这个浏览器不支持语音识别（Chrome / Edge 支持）。' +
                '可以在右边输入框里打字下达同样的指令。', true);
      return;
    }
    if (E2.listening && E2.rec) {
      E2.rec.stop();       // 再点一次 = 提前收工
      return;
    }

    var rec = new SpeechRec();
    E2.rec = rec;
    rec.lang = 'zh-CN';
    rec.interimResults = false;
    rec.continuous = false;
    rec.maxAlternatives = 1;

    rec.onstart = function () {
      E2.listening = true;
      el.micBtn.classList.add('is-listening');
      el.micBtn.innerHTML = '<span class="e2-ico" aria-hidden="true">🛑</span>停止收音';
      setStatus('正在收音…可说：查看宿舍区zone-n / 查看教学区zone-s / 查看食堂区zone-w / 记录现场 / 朗读结论');
    };

    rec.onresult = function (e) {
      var text = '';
      for (var i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) text += e.results[i][0].transcript;
      }
      if (text) runCommand(text, 'voice');
    };

    rec.onerror = function (e) {
      var tips = {
        'not-allowed': '麦克风被拒绝：点地址栏的锁图标允许麦克风后重试',
        'service-not-allowed': '浏览器拒绝了语音识别服务。用 http://127.0.0.1 打开本页可解决；' +
                               '也可以直接在右边输入框打字',
        'no-speech': '没听到声音，再说一次',
        'audio-capture': '没找到麦克风设备',
        'network': '语音识别服务连不上（需要联网）。可以在右边输入框打字下达同样的指令'
      };
      setStatus(tips[e.error] || ('语音识别失败：' + e.error), true);
    };

    rec.onend = function () {
      E2.listening = false;
      el.micBtn.classList.remove('is-listening');
      el.micBtn.innerHTML = '<span class="e2-ico" aria-hidden="true">🎤</span>语音指令';
    };

    try {
      rec.start();
    } catch (err) {
      setStatus('语音识别启动失败：' + err.message, true);
    }
  }

  /* 指令总入口：语音识别结果与文字输入框都走这里 */
  function runCommand(text, source) {
    var cmd = parseCommand(text);
    var who = source === 'voice' ? '语音「' : '指令「';
    if (cmd.zoneId) E2.voiceTarget = cmd.zoneId;   // 指令里点了名就记下来

    if (cmd.action === 'view' && cmd.zoneId) {
      highlightZone(cmd.zoneId);
      setStatus(who + text + '」→ 已高亮 ' + zoneLabel(cmd.zoneId));
      e2Speak('已查看' + zoneLabel(cmd.zoneId));
    } else if (cmd.action === 'photo') {
      setStatus(who + text + '」→ 记录现场');
      openCamera();
    } else if (cmd.action === 'speak') {
      setStatus(who + text + '」→ 朗读结论');
      speakConclusion(cmd.zoneId);
    } else {
      setStatus(who + text + '」没听懂：可说 查看宿舍区zone-n / 记录现场 / 朗读结论', true);
    }
    return cmd;
  }

  /* ===========================================================================
   * 7. 启动
   * ======================================================================== */

  function init() {
    cacheEls();
    cacheTheme();
    bindEvents();

    chart = initChart();
    Store.subscribe(render);

    /* E2：现场记录的空态；麦克风按钮在浏览器不支持语音识别时禁用并说明原因 */
    renderPhotos();
    if (el.micBtn && !SpeechRec) {
      el.micBtn.disabled = true;
      el.micBtn.title = '这个浏览器不支持语音识别（Chrome / Edge 支持）；' +
                        '可用右边的输入框打字下达同样的指令';
    }

    /* 不做任何恢复：区域卡片、趋势曲线、事件列表、D3 状态机全部只活在内存里，
       刷新即回到「等第一条报文」，由本次会话新收到的数据重新建立
       （跨端一致性靠 MQTT 干预广播收敛） */

    render(Store.state);      // 首屏：空态，等 MQTT 推送

    Mqtt.start();

    /* 暴露共享状态，供移动端 / 地图3D 等其它端复用同一份数据源 */
    window.AirGuard = {
      config: CONFIG,
      zones: ZONES,
      levels: LEVELS,
      crowdLevels: CROWD_LEVELS,
      store: Store,
      subscribe: Store.subscribe,
      getSnapshot: Store.getSnapshot,
      /* 持续风险与优先关注：打分结果与感知记录，供联调与自动化测试使用。
         注意这是内存态，不落盘，刷新即重来（见 2.7 节说明）。 */
      priority: {
        source: PRIORITY_SOURCE,
        envSingle: PRIORITY_ENV_SINGLE,
        envStreak: PRIORITY_ENV_STREAK,
        rows: function () { return Store.state.priority.rows; },
        winner: function () { return Store.state.priority.winner; },
        streaks: function () { return Store.state.streaks; },
        streakStart: function () { return Store.state.streakStart; },
        spanText: Store.spanText,
        perception: function () { return Store.state.perception; }
      },
      /* 导出记录（只存内存，刷新即清零）：清空按钮与自动化测试使用 */
      history: {
        limit: CONFIG.historyLimit,
        records: historyRecords,     // 同一个引用，不复制
        clear: clearHistory
      },
      /* ---- D3 干预—验证—恢复：事件状态机 ----
         暴露给联调和自动化测试。四端各有一份实现，靠同一套规则与 MQTT 广播收敛。 */
      events: {
        limit: CONFIG.maxEvents,
        OPEN: EV_OPEN, HANDLING: EV_HANDLING, RECOVERED: EV_RECOVERED,
        recoverSamples: 1,
        relapseSamples: EV_RELAPSE_SAMPLES,
        confidenceFloor: EV_CONFIDENCE_FLOOR,
        actions: EV_ACTIONS,
        label: EV_LABEL,
        list: function () { return Store.state.events; },        // 同一个引用，不复制
        active: function (zoneId) {
          return zoneId === undefined ? Store.state.activeEvents : Store.state.activeEvents[zoneId];
        },
        /* 提交干预（等价于在卡片上勾选后点【执行干预】） */
        intervene: function (zoneId, actions, actor) {
          var ev = Store.intervene(zoneId, actions, { actor: actor || 'web' });
          if (ev) Mqtt.publishIntervention(ev, actions);
          return ev;
        },
        /* 模拟从别端广播来的干预，供跨端一致性测试用 */
        receive: function (msg) { return Store.receiveIntervention(msg); },
        connected: Mqtt.isConnected
      },
      /* ---- E2：语音指令 / 记录现场 / 朗读结论 ----
         只存内存，不落盘、不上传；指令解析是纯函数，方便控制台直接验 */
      e2: {
        commands: ['查看宿舍区zone-n', '查看教学区zone-s', '查看食堂区zone-w', '记录现场', '朗读结论'],
        parseCommand: parseCommand,
        run: runCommand,                       // 等价于说一句指令
        speak: speakConclusion,                // 朗读结论
        highlight: highlightZone,              // 查看某区域（高亮卡片）
        openCamera: openCamera,
        shoot: shootPhoto,                     // 直接拍一张（摄像头已就绪时）
        closeCamera: closeCamera,
        conclusionText: conclusionText,        // 该区域的播报稿
        speechSupported: !!SpeechRec,
        ttsSupported: !!window.speechSynthesis,
        photos: E2.photos,                     // 同一个引用，不复制
        photoMax: E2.PHOTO_MAX,
        voiceTarget: function () { return E2.voiceTarget; }
      },
      /* 事件列表（状态流水，只存内存）：供联调与自动化测试使用 */
      alerts: {
        limit: CONFIG.maxAlerts,
        records: Store.state.alerts       // 同一个引用，不复制
      },
      /* 手动注入一条读数（本地联调 / 其它模块调用），payload 字段同 MQTT 报文 */
      pushReading: function (payload, zoneId) {
        var id = zoneId || deriveZoneId(Store.field(payload, ['zoneid', 'zone_id', 'zone']));
        if (!id) { console.warn('[AirGuard] pushReading 无法识别区域'); return null; }
        return Store.ingest(payload, id, { verified: false });
      },
      /* 按 MQTT 主题注入一条原始报文：与真实订阅走完全相同的解析 + 双重校验路径，
         自动化测试用它验证串区 / 区域不可识别的报文确实被拒收 */
      pushTopic: function (topic, raw) {
        var before = Store.state.counters.rejected;
        Mqtt.ingestRaw(topic, String(raw));
        return { rejected: Store.state.counters.rejected > before };
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
