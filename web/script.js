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
 *   主题： Airguard/+/data          （+ 为区域通配符，例如 Airguard/zone-n/data）
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
      url: 'ws://127.0.0.1:8085',        // Broker 的 WebSocket 监听地址
      topic: 'Airguard/+/data',          // + 通配符：一次订阅全部区域的 data 主题
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
    mergeWindowMs: 2000, // 同一时刻内的多条报文合并为一个采样点（便于三区横向对比）

    /* ---- 本地持久化 ---- */
    storageKey: 'airguard.history.web.v1',  // 每个端一个独立键，避免同源多页面互相覆盖
    alertStorageKey: 'airguard.alerts.web.v1',  // 事件列表单独一个键：它是「状态流水」，与 CSV 存档不是一回事
    historyLimit: 5000,                     // 最多保留 5000 条，超出丢最旧的
    saveDebounceMs: 400                     // 写入节流，见 6.6 节说明
  };

  /* ---------------------------------------------------------------------------
   * 导出用的历史记录：每收到一条通过校验的 MQTT 报文就追加一条，
   * 字段顺序固定为 time, zone, pm25, co2, crowdLevel, status，与 CSV 表头一一对应。
   * 刻意挂到 window 上——这样它是真正的全局数组，控制台里直接敲 historyRecords 就能检视。
   *
   * 这个数组同时是本地存储的镜像：启动时从 localStorage 恢复，收到新报文后
   * 节流写回。数组本体始终是同一个引用（恢复时用 splice 就地改写而不是重新赋值），
   * 否则 window.historyRecords 会指向旧数组，控制台里看到的就不是实时数据了。
   * ------------------------------------------------------------------------ */
  var historyRecords = window.historyRecords = [];

  /* 本次会话从本地缓存恢复的情况，供顶栏提示用；没恢复过就是 null */
  var restoreInfo = null;

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
      counters: { messages: 0, rejected: 0, statusMismatch: 0 },
      streaks: {},          // zoneId -> 末尾连续异常条数（见 2.7 节）
      streakStart: {},      // zoneId -> 本轮连续异常首条记录的时刻（ms），正常时清空
      perception: [],       // 感知记录，最新在前，最多 CONFIG.maxPerception 条
      priority: { rows: [], winner: null }   // 优先关注打分结果
    };

    var listeners = [];
    var alertSeq = 0;
    var perceptionSeq = {};   // zoneId -> 该区域已产生的感知记录条数（imageId 用）

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
        cached: !!opts.cached         // 来自本地存储的历史读数，不是本次会话收到的报文
      };

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
     *     数组恒定「新的在前」，持久化与渲染都依赖这个顺序
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
      scheduleSave();     // 事件列表也落盘，见 6.6 节
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
      /* 用本地历史重建趋势曲线。只动曲线，不碰实时状态——
         cached 入库时刻意跳过了 appendSample，曲线在这里一次性补齐。 */
      restoreCurve: function (slots) {
        state.history = slots.slice(-CONFIG.historySize);
        notify();
      },
      /* 用本地存档重建事件列表（数组恒定「新的在前」）。
         就地填充而不是换数组：外部已经拿到的引用要继续有效。
         顺带把 id 序号推到存档最大值之后，新记录不会和旧的撞号。 */
      restoreAlerts: function (list) {
        state.alerts.length = 0;
        for (var i = 0; i < list.length && i < CONFIG.maxAlerts; i++) {
          state.alerts.push(list[i]);
          var m = /^ev-(\d+)$/.exec(list[i].id || '');
          if (m) alertSeq = Math.max(alertSeq, Number(m[1]));
        }
        notify();
      },
      /* 把内存状态整体归零，回到「等 MQTT 推送」的初始态。
         注意：这个不再挂到任何按钮上——【清空本地记录】只删本地存档，
         屏幕上的实时画面保持不动（见 clearHistory）。这里留给联调与
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

  /* 从主题里识别区域：Airguard/zone-n/data → zone-n */
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

  /* 采样时间解析：支持毫秒/秒时间戳、"2026-10-03 09:12:00"、ISO 字符串 */
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
     * ----------------------------------------------------------------- */
    function resolveZone(topic, payload) {
      var fromTopic = zoneFromTopic(topic);
      var rawPayloadZone = Store.field(payload, ['zoneid', 'zone_id', 'zone']);
      var fromPayload = deriveZoneId(rawPayloadZone);

      // 两路都有值：必须一致，否则判定为串区报文并丢弃
      if (fromTopic && fromPayload) {
        if (fromTopic !== fromPayload) {
          return {
            error: 'mismatch',
            detail: '主题指向 ' + fromTopic + '，报文 zoneid 却是 ' + fromPayload
          };
        }
        return { zoneId: fromTopic, verified: true };
      }

      // 只有一路有值：仍然接收，但标记为未通过双重校验
      if (fromTopic)   return { zoneId: fromTopic, verified: false };
      if (fromPayload) return { zoneId: fromPayload, verified: false };

      return { error: 'unknown', detail: '主题与报文都无法识别区域' };
    }

    function onMessage(topic, payloadBuf) {
      var text = payloadBuf.toString();

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
      scheduleSave();     // 节流写回本地存储，见 6.6 节

      setConnNote('已连接 · 最近一条：' + r.zoneId + ' · ' + topic +
                  (r.verified ? ' · 双重校验通过' : ' · ⚠ 仅单路可识别区域'));
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
          client.subscribe(CONFIG.mqtt.topic, { qos: CONFIG.mqtt.qos }, function (err) {
            if (err) {
              Store.setConn('error', '⚠ 订阅失败：' + err.message);
              return;
            }
            Store.setConn('connected',
              '已连接 ' + CONFIG.mqtt.url + ' · 已订阅 ' + CONFIG.mqtt.topic + ' · 等待报文…');
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
      isRunning: function () { return !!client; }
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
             'priorityFocus', 'priorityScoreBody', 'priorityEmpty', 'priorityPanel'];

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

    /* 只要还有区域停留在「本地缓存」态，就在状态条上说明这些读数来自哪里、
       是什么时候的。三个区域都被新报文覆盖后，这行提示自动消失。
       count 归零表示本地存档已被清空，但屏幕上的缓存读数还在，照样要交代。 */
    var note = state.connNote;
    if (restoreInfo) {
      var stillCached = ZONES.filter(function (z) {
        return state.zones[z.id] && state.zones[z.id].cached;
      }).length;
      if (stillCached) {
        note = (restoreInfo.count
                  ? '已恢复 ' + restoreInfo.count + ' 条本地历史'
                  : '本地存档已清空') +
               ' · ' + stillCached + ' 个区域仍是缓存读数（' + restoreInfo.lastStamp + '）· ' + note;
      }
    }

    el.linkNote.textContent = note;
    el.linkNote.classList.toggle('is-warn', /⚠/.test(note));
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

      html += '<article class="zone-card' + (idle ? ' is-idle' : '') + (isFocus ? ' is-focus' : '') +
              (isCached ? ' is-cached' : '') + '"' +
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

  /* ---------------------------------------------------------------------------
   * 6.6 本地持久化：historyRecords 与 localStorage 双向同步
   *
   * 为什么要有这一层：MQTT 是实时流，页面一刷新内存里的 historyRecords 就清零，
   * 导出的 CSV 也跟着只剩刷新后收到的几条。存到本地后，刷新 / 重开浏览器都能接着攒，
   * 导出拿到的是跨会话的完整记录；面板也会用最后一次读数填上，不留白。
   * ------------------------------------------------------------------------ */

  /* localStorage 在无痕模式 / 禁用站点数据 / 某些 file:// 场景下会直接抛异常。
     先探测一次，不可用就整体降级为「只存内存」，页面其余功能照常运行。 */
  var storageOk = (function () {
    try {
      var probe = '__airguard_probe__';
      window.localStorage.setItem(probe, '1');
      window.localStorage.removeItem(probe);
      return true;
    } catch (e) {
      console.warn('[AirGuard] 本地存储不可用，历史记录只保留在内存中：', e && e.message);
      return false;
    }
  })();

  /* 一条记录至少要能拼成一行合法 CSV 才值得留着 */
  function isValidRecord(r) {
    return !!r && typeof r === 'object' &&
           typeof r.time === 'string' && r.time &&
           typeof r.zone === 'string' && r.zone;
  }

  function loadHistory() {
    if (!storageOk) return [];
    var raw;
    try {
      raw = window.localStorage.getItem(CONFIG.storageKey);
    } catch (e) {
      return [];
    }
    if (!raw) return [];

    try {
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      // 逐条校验：存储可能被手工改过，或来自旧版本的结构
      return arr.filter(isValidRecord).slice(-CONFIG.historyLimit);
    } catch (e) {
      console.warn('[AirGuard] 本地历史不是合法 JSON，已忽略：', e && e.message);
      return [];
    }
  }

  /* 事件记录比历史记录窄得多：能认出区域、等级和时间就够渲染一行了 */
  function isValidAlert(a) {
    return !!a && typeof a === 'object' && !Array.isArray(a) &&
           typeof a.zoneId === 'string' && !!a.zoneId &&
           typeof a.ts === 'number' && isFinite(a.ts) &&
           !!LEVELS[a.level];
  }

  function loadAlerts() {
    if (!storageOk) return [];
    var raw;
    try {
      raw = window.localStorage.getItem(CONFIG.alertStorageKey);
    } catch (e) {
      return [];
    }
    if (!raw) return [];

    try {
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      /* 数组是「新的在前」，所以超出上限时该砍的是尾部（最旧的），
         不能照搬 loadHistory 的 slice(-n)——那是给「旧的在前」的历史记录用的 */
      return arr.filter(isValidAlert).slice(0, CONFIG.maxAlerts);
    } catch (e) {
      console.warn('[AirGuard] 本地事件记录不是合法 JSON，已忽略：', e && e.message);
      return [];
    }
  }

  function saveAlerts() {
    if (!storageOk) return;
    /* 这里在 Store 闭包外面，拿不到闭包内的 state，必须走 Store.state */
    var alerts = Store.state.alerts;
    if (alerts.length > CONFIG.maxAlerts) {
      alerts.length = CONFIG.maxAlerts;
    }
    try {
      window.localStorage.setItem(CONFIG.alertStorageKey, JSON.stringify(alerts));
    } catch (e) {
      // 与历史记录共用一份配额，写不进去就放弃本次存档，不影响实时监测
      console.warn('[AirGuard] 本地事件记录写入失败：', e && e.message);
    }
  }

  var saveTimer = null;

  /* 一次落盘两张表：历史记录（CSV 存档）与事件列表（状态流水）。
     共用同一个节流窗口，避免两套定时器互相抢主线程 */
  function persistAll() {
    saveHistory();
    saveAlerts();
  }

  function saveHistory() {
    if (!storageOk) return;
    // 上限在这里也要压一次：loadHistory 只在启动时筛，页面上连收几小时
    // 报文的话内存与存档都会一路涨上去
    var over = historyRecords.length - CONFIG.historyLimit;
    if (over > 0) historyRecords.splice(0, over);
    try {
      window.localStorage.setItem(CONFIG.storageKey, JSON.stringify(historyRecords));
      return;
    } catch (e) {
      // 配额写满：丢掉一半最旧的再试一次。存档失败不该影响实时监测，所以不往上抛。
      console.warn('[AirGuard] 本地存储写入失败，丢弃最旧的记录后重试：', e && e.message);
    }
    historyRecords.splice(0, Math.ceil(historyRecords.length / 2));
    try {
      window.localStorage.setItem(CONFIG.storageKey, JSON.stringify(historyRecords));
    } catch (e2) {
      console.error('[AirGuard] 本地存储仍无法写入，本次存档跳过：', e2 && e2.message);
    }
  }

  /* 每条报文都同步写一次 localStorage 会阻塞主线程（JSON.stringify + 磁盘写，
     大屏上三条报文连着来就很明显），所以攒一小段时间再写。
     页面隐藏 / 关闭时补一次，保证不丢最后几百毫秒内的数据。 */
  function scheduleSave() {
    if (!storageOk || saveTimer) return;
    saveTimer = setTimeout(function () {
      saveTimer = null;
      persistAll();
    }, CONFIG.saveDebounceMs);
  }

  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    persistAll();
  }

  window.addEventListener('pagehide', flushSave);
  window.addEventListener('beforeunload', flushSave);

  /* 启动时把本地记录回灌成页面状态：
       ① historyRecords —— 导出 CSV 用
       ② 每个区域最后一次读数 —— 走 Store.ingest 的 cached 分支
       ③ 趋势曲线的采样点
     全程不产生告警、不计数，它们是历史，不是本次会话收到的报文。 */
  function restoreHistory() {
    var saved = loadHistory();
    if (!saved.length) return 0;

    // 就地改写而不是 historyRecords = saved：
    // window.historyRecords 必须和内部变量始终指向同一个数组
    historyRecords.length = 0;
    Array.prototype.push.apply(historyRecords, saved);

    var lastByZone = {};
    var lastTsByZone = {};
    var slots = [];

    for (var i = 0; i < saved.length; i++) {
      var rec = saved[i];

      /* 时间读不出来，只影响这条记录能不能画到曲线上，不影响
         「这个区域上次是什么读数」——Store.ingest 遇到同样读不出时间的报文
         也会退回本地接收时刻照常入库。两条路径对时间的容忍度必须一致，
         否则会出现「实时看得见、一刷新这个区域就变回等待数据」这种
         只在刷新时才暴露的缺口。 */
      lastByZone[rec.zone] = rec;
      var ts = parseStamp(rec.time);
      if (ts === null) continue;
      lastTsByZone[rec.zone] = ts;

      // 与 appendSample 用同一套合并规则重建曲线，保证刷新前后曲线形状一致
      var slot = slots[slots.length - 1];
      if (!slot || ts - slot.ts > CONFIG.mergeWindowMs) {
        slot = { ts: ts, label: fmtTime(ts), values: {} };
        for (var j = 0; j < ZONES.length; j++) slot.values[ZONES[j].id] = null;
        slots.push(slot);
      }
      var pm = num(rec.pm25, null);
      if (pm !== null) slot.values[rec.zone] = pm;
    }

    /* 说明里的时间戳取「能解析出来的那批里最新的」，
       全都解析不出来时才退回字符串比较 */
    var lastStamp = '';
    var lastTs = null;
    for (var k = 0; k < ZONES.length; k++) {
      var id = ZONES[k].id;
      var last = lastByZone[id];
      if (!last) continue;

      var t = lastTsByZone[id];
      if (t !== undefined) {
        if (lastTs === null || t > lastTs) { lastTs = t; lastStamp = last.time; }
      } else if (lastTs === null && last.time > lastStamp) {
        lastStamp = last.time;
      }

      Store.ingest(last, id, { verified: true, cached: true });
    }

    Store.restoreCurve(slots);

    restoreInfo = { count: saved.length, lastStamp: lastStamp || '未知' };
    console.info('[AirGuard] 已从本地存储恢复 ' + saved.length + ' 条历史记录');
    return saved.length;
  }

  /* 启动时把本地存档的事件列表读回内存。
     读回的是上次刷新前的样子，新报文到达后自然接在后面 */
  function restoreAlerts() {
    var saved = loadAlerts();
    Store.restoreAlerts(saved);
    if (saved.length) {
      console.info('[AirGuard] 已从本地存储恢复 ' + saved.length + ' 条事件记录');
    }
    return saved.length;
  }

  /* 清空本地记录：historyRecords（CSV 存档）与 state.alerts（事件列表）一起清，
     两者都是「记录」，屏幕上也要跟着消失。
     区域卡片与趋势曲线不动——那是当前这一秒的实时读数，不是记录。

     内存必须一起清，不能只删存储：页面卸载时 pagehide → flushSave → persistAll
     会拿内存里的数组重新写盘，只删存储等于白删，刷新一次记录又全回来了。 */
  function clearHistory() {
    var alerts = Store.state.alerts;
    if (!window.confirm('确定清空本地保存的全部历史记录？\n\n' +
                        '将删除已保存的 ' + historyRecords.length + ' 条历史记录，' +
                        '以及事件列表中的 ' + alerts.length + ' 条。\n' +
                        '此操作不可撤销。')) {
      return;
    }

    historyRecords.length = 0;
    alerts.length = 0;
    if (restoreInfo) restoreInfo.count = 0;   // 保留 lastStamp：屏幕上的缓存读数还需要它
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

    /* 两张表的存档一起删：历史存档（CSV 用）与事件列表（状态流水） */
    if (storageOk) {
      [CONFIG.storageKey, CONFIG.alertStorageKey].forEach(function (key) {
        try {
          window.localStorage.removeItem(key);
        } catch (e) {
          console.warn('[AirGuard] 清除本地存储失败（' + key + '）：', e && e.message);
        }
      });
    }

    render(Store.state);       // 事件列表重绘为空，状态条也改口说明存档已清空
    console.info('[AirGuard] 已清空本地记录（历史 + 事件列表），区域卡片与趋势曲线不受影响');
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

    /* 先把上次存下的历史灌回面板（没有就保持空态），再开 MQTT。
       顺序很重要：先起连接的话，首帧会先闪一下空面板再被历史填上。 */
    restoreHistory();
    restoreAlerts();          // 事件列表同样先回灌，刷新后列表不会空着

    render(Store.state);      // 首屏：有本地历史就直接显示（带「本地缓存」标记），否则等 MQTT 推送

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
      /* 本地持久化：导出 / 清空 / 立即落盘，供联调与自动化测试使用 */
      history: {
        key: CONFIG.storageKey,
        available: storageOk,
        records: historyRecords,
        load: loadHistory,
        save: flushSave,
        clear: clearHistory,
        restore: restoreHistory
      },
      /* 事件列表（状态流水）的本地持久化，同样供联调与自动化测试使用 */
      alerts: {
        key: CONFIG.alertStorageKey,
        limit: CONFIG.maxAlerts,
        records: Store.state.alerts,      // 同一个引用，不复制
        load: loadAlerts,
        save: saveAlerts,
        restore: restoreAlerts
      },
      /* 手动注入一条读数（本地联调 / 其它模块调用），payload 字段同 MQTT 报文 */
      pushReading: function (payload, zoneId) {
        var id = zoneId || deriveZoneId(Store.field(payload, ['zoneid', 'zone_id', 'zone']));
        if (!id) { console.warn('[AirGuard] pushReading 无法识别区域'); return null; }
        return Store.ingest(payload, id, { verified: false });
      }
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
