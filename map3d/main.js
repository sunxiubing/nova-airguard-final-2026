/* ============================================================================
 * AirGuard · 校园多区域空气质量与人流监测预警协同系统
 * 三维数字孪生沙盘（map3d/main.js）
 * ----------------------------------------------------------------------------
 * 与 web/ 大屏、mobile/ 小程序共用同一条实时数据流：
 *     订阅  ws://127.0.0.1:8085   Airguard/+/data
 *     报文  { zoneId, pm25, co2, crowdLevel, status, time }
 *
 * 可视化分层（彼此独立，不混淆）：
 *     楼宇本体      固定浅灰白实体，不承载任何状态，永不变色
 *     悬浮发光标牌   → 空气质量   （DOM 投影到三维锚点）
 *     楼层环绕灯带   → 整栋楼人流（每层一圈，同栋同色，硬性规则）
 *     地面光晕环     → 风险处置中的脉冲扩散
 *
 * 目录：
 *     ① 配置与色板   ② 业务规则   ③ 数据层 Store
 *     ④ 场景         ⑤ 楼宇搭建   ⑥ 悬浮标签
 *     ⑦ 状态渲染     ⑧ 交互       ⑨ 本地持久化
 *     ⑩ MQTT 接入与启动
 * ========================================================================== */

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

/* ==========================================================================
 * ① 配置与色板
 * ======================================================================== */

/** MQTT 接入参数：与 web 大屏、微信小程序保持一致 */
const MQTT_CONFIG = {
  url: 'ws://127.0.0.1:8085',
  topic: 'Airguard/+/data',
  qos: 0,
  keepalive: 30,
  reconnectPeriod: 3000,
  connectTimeout: 8000,
};

/* --- 楼宇与监测区域一一对应 -------------------------------------------------
 *  坐标由相机方位反解得到，保证「宿舍区在左 / 教学区在右上 / 食堂区在右下」
 *  的同时，为左下角图例与右下角数据面板让出屏幕空间。
 *  尺寸差异用于区分楼宇类型，不承载任何状态。
 * -------------------------------------------------------------------------- */
const BUILDINGS = [
  {
    id: 'zone-n',
    name: '宿舍区',
    code: 'ZONE-N',
    desc: '长条形多层宿舍楼 · 横向窗带 · 平顶',
    pos: [-10.9, 0, 5.1],
    size: [9.0, 7.5, 4.2],       // 横向最长、楼层最高
    floors: 6,
    window: { h: 0.34, fill: 0.86, pitch: 1.80 },
    roof: [
      { shape: 'box', size: [1.5, 0.55, 1.1], pos: [-2.6, 0, 0.3] },
      { shape: 'cyl', size: [0.44, 0.70], pos: [2.7, 0, -0.5] },
    ],
    labelLift: 2.1,
  },
  {
    id: 'zone-s',
    name: '教学区',
    code: 'ZONE-S',
    desc: '方正中等高度教学楼 · 网格窗 · 平顶',
    pos: [3.1, 0, -8.7],
    size: [6.0, 5.6, 6.0],       // 方正、中等高度
    floors: 4,
    window: { h: 0.62, fill: 0.62, pitch: 1.50 },
    roof: [
      { shape: 'box', size: [1.9, 0.60, 1.5], pos: [0, 0, 0.2] },
    ],
    labelLift: 2.1,
  },
  {
    id: 'zone-w',
    name: '食堂区',
    code: 'ZONE-W',
    desc: '矮宽扁平食堂 · 横向窗带 · 平顶',
    pos: [10.4, 0, 2.1],
    size: [7.2, 3.4, 5.8],       // 三栋中最低、最扁平
    floors: 2,
    window: { h: 0.52, fill: 0.84, pitch: 2.20 },
    roof: [
      { shape: 'box', size: [1.3, 0.85, 1.3], pos: [-2.4, 0, -1.6] },
      { shape: 'box', size: [0.9, 0.55, 0.9], pos: [2.6, 0, 1.9] },
    ],
    labelLift: 1.9,
  },
];

/** 空气质量等级 → 悬浮标牌配色，与 web/ 大屏、mobile/ 小程序语义一致 */
const LEVELS = {
  good: {
    rank: 0, label: '正常', color: '#12a150', ink: '#0b6b36', pulse: false,
    actions: ['维持现有通风与人员管理'],
  },
  warning: {
    rank: 1, label: '轻度污染', color: '#e8a317', ink: '#8a5f00', pulse: true,
    actions: ['减少长时间停留', '适时开窗换气'],
  },
  serious: {
    rank: 2, label: '通风不足风险', color: '#e2681f', ink: '#8c3d06', pulse: true,
    actions: ['立即开窗加强通风', '疏散密集人群'],
  },
  critical: {
    rank: 3, label: '重度污染', color: '#d32f2f', ink: '#8e1a1a', pulse: true,
    actions: ['限制人员停留', '暂停室内活动', '开启空气净化设备'],
  },
  idle: {
    rank: -1, label: '待机', color: '#9aa6b4', ink: '#5b6675', pulse: false,
    actions: ['等待该区域数据接入'],
  },
};

/* --- 人流密度等级 → 楼层环绕灯带配色（蓝色系 → 紫色系，独立于空气质量色系）
 *  硬性规则：同一栋楼宇的全部楼层灯带取同一个 crowdLevel，颜色完全相同。
 *  实现上由「整栋楼共用同一份材质」这一数据结构保证，不存在逐层差异的可能。
 * -------------------------------------------------------------------------- */
const FLOW_LEVELS = [
  { key: 0, label: '人流稀疏',     short: '稀疏',     color: '#5cbcf2', pulse: false },
  { key: 1, label: '人流正常',     short: '正常',     color: '#2f7ad4', pulse: false },
  { key: 2, label: '人流拥挤',     short: '拥挤',     color: '#12724a', pulse: true  },
  { key: 3, label: '人流严重拥挤', short: '严重拥挤', color: '#4a2178', pulse: true  },
];

/** 未收到数据时的待机态灯带 */
const FLOW_IDLE = { key: -1, label: '等待数据', short: '待机', color: '#c2cad4', pulse: false };

/** 人流等级对应的处置建议（风险时与空气质量建议合并展示） */
const FLOW_ACTIONS = {
  2: ['疏导人流，控制区域密度'],
  3: ['立即限流，分批次进入', '疏散密集人群'],
};

/* --- 持续风险与优先关注 ------------------------------------------------------
 *  与 Web 大屏 / 移动端（浏览器版 + 小程序）/ 分析报告共用同一套打分规则，
 *  改动必须五处同步：
 *      总分 = 环境异常分 + 人流分
 *      环境异常分：末尾连续异常 0 条 = 0；1 条 = 1（单次异常）；≥2 条 = 3（连续多次异常）
 *      人流分：稀疏 0 / 正常 1 / 拥挤 2 / 严重拥挤 3
 *  取总分最高者为【当前优先关注】，平分依次比环境分、人流分，
 *  再按 BUILDINGS 的固定顺序兜底，保证同一批数据永远算出同一个结果。
 *
 *  地图上的落点只有三处，都不碰楼体本体（见文件头的可视化分层约定）：
 *      楼体轮廓线 → 橙色加粗描边
 *      地面光晕环 → 橙色常亮脉冲
 *      悬浮标签   → 挂「优先关注」徽标
 * -------------------------------------------------------------------------- */
const PRIORITY_ENV_SINGLE = 1;     // 单次异常
const PRIORITY_ENV_STREAK = 3;     // 连续多次异常
const PRIORITY_SOURCE = 'review';  // 感知记录来源，全系统固定；confidence 固定为 null
const PRIORITY_LIMIT = 30;         // 感知记录保留条数（内存态，不落盘）

const PRIORITY_ACCENT = '#c2410c';            // 「优先关注」专用强调色，五端同一支
const PRIORITY_HALO = new THREE.Color(PRIORITY_ACCENT);   // 地面光晕环用
const PRIORITY_EDGE = 0xc2410c;               // 轮廓线：优先关注
const EDGE_HOVER = 0x3d4b5c;                  // 轮廓线：鼠标悬浮
const EDGE_IDLE = 0xc4ccd7;                   // 轮廓线：常态

/* --- 沙盘几何与相机 --------------------------------------------------------
 *  相机默认 45° 斜俯视（方位角 30°、仰角 45°），支持拖拽旋转与滚轮缩放。
 * -------------------------------------------------------------------------- */
const SCENE = {
  cameraPos: new THREE.Vector3(16.6, 37.3, 32.5),   // 仰角 46°、方位角 30°
  target: new THREE.Vector3(-0.4, 2.0, 3.1),
  minDist: 18,
  maxDist: 110,
  sky: 0xe9eef4,
};

/** 楼宇本体的固定配色：不随任何数据变化 */
const BODY_COLOR = '#eceef1';
const ROOF_COLOR = '#d5dbe3';   // 比墙体略深，让平顶与立面在俯视下分得开
const GEAR_COLOR = '#c3cbd6';   // 屋顶设备箱
const PANE_COLOR = '#8792a3';

/* ==========================================================================
 * ② 业务规则（与 web/ 大屏、mobile/ 小程序同源）
 * ======================================================================== */

/** 环境结论：pm25 > 150 重度污染；> 75 轻度污染；否则 co2 ≥ 1500 通风不足风险；否则正常 */
function evaluateLevel(pm25, co2) {
  if (typeof pm25 === 'number' && pm25 > 150) return 'critical';
  if (typeof pm25 === 'number' && pm25 > 75) return 'warning';
  if (typeof pm25 === 'number' && pm25 <= 75 && typeof co2 === 'number' && co2 >= 1500) return 'serious';
  return 'good';
}

/** 该区域是否处于风险态：空气质量异常 或 人流等级 ≥ 2 */
function isRisk(level, crowdLevel) {
  return level !== 'good' || (typeof crowdLevel === 'number' && crowdLevel >= 2);
}

/** 归一化字段名：兼容 pm25 / PM2.5 / pm2_5 / co₂ / CO2 等写法 */
function normKey(k) {
  return String(k).toLowerCase().replace(/₂/g, '2').replace(/[^a-z0-9]/g, '');
}

/** 大小写与分隔符不敏感的取值器 */
function makeKeyPicker(obj) {
  const map = new Map();
  for (const k of Object.keys(obj)) map.set(normKey(k), obj[k]);
  return (name) => (map.has(name) ? map.get(name) : null);
}

function toNumber(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function clampCrowd(n) {
  if (n === null || n === undefined) return null;
  const i = Math.round(n);
  return i >= 0 && i <= 3 ? i : null;
}

/** 人流分：稀疏 0 / 正常 1 / 拥挤 2 / 严重拥挤 3。
 *  缺失的取值按 0 分算——打分要的是一个确定的数，
 *  而标牌与面板上的感知结论仍然如实显示「等待数据」。 */
function crowdScore(level) {
  return typeof level === 'number' && level >= 0 && level <= 3 ? level : 0;
}

/** 评分档位 → 中文标签。用的就是灯带那一套四档短标签，五端逐字一致 */
function crowdLabelOf(level) {
  return FLOW_LEVELS[crowdScore(level)].short;
}

/** 时长文案：不足 1 分 → 「N 秒」；不足 1 时 → 「M 分 S 秒」；再长 → 「H 时 M 分」 */
function spanText(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} 分 ${s % 60} 秒`;
  return `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

/** 优先关注的判断理由，文案与另外四端逐字一致 */
function priorityReason(r) {
  let envTxt;
  if (r.env === 0) {
    envTxt = '环境正常 0 分';
  } else if (r.streak === 1) {
    envTxt = `环境单次异常（${r.levelLabel}）${PRIORITY_ENV_SINGLE} 分`;
  } else {
    envTxt = `环境连续 ${r.streak} 次异常（${r.levelLabel}）已持续 ` +
             `${spanText(r.span)} ${PRIORITY_ENV_STREAK} 分`;
  }
  return `${envTxt} + 人流${r.crowdLabel} ${r.crowd} 分 → 总分 ${r.total}`;
}

/* 同分裁决链的比较器：返回负数表示 a 更该先看。
   前四级全平时返回 0，由调用方的「严格更优才换人」保持 BUILDINGS 的先后。 */
function comparePriority(a, b) {
  if (a.total !== b.total) return b.total - a.total;
  if (a.span !== b.span) return b.span - a.span;
  if (a.env !== b.env) return b.env - a.env;
  if (a.crowd !== b.crowd) return b.crowd - a.crowd;
  return 0;
}

/** 裁决理由：回答「凭什么是它」。rival 是按同一裁决链排出来的第二名 */
function priorityVerdict(win, rival) {
  if (!rival || rival.total !== win.total) {
    return `${win.name}总分 ${win.total} 为三区最高` +
           (rival ? `（次高 ${rival.total} 分）` : '') + '，综合风险最该先处理';
  }
  const head = `与${rival.name}同为 ${win.total} 分`;
  if (win.span !== rival.span) {
    return `${head}；${win.name}环境异常已持续 ${spanText(win.span)}，` +
           `比${rival.name}（${spanText(rival.span)}）更久，故先处理`;
  }
  if (win.env !== rival.env) {
    return `${head}、持续时长相同；${win.name}环境异常分更高（` +
           `${win.env} 对 ${rival.env}），故先处理`;
  }
  if (win.crowd !== rival.crowd) {
    return `${head}、持续时长与环境分均相同；${win.name}人流密度等级更高（` +
           `${win.crowdLabel} 对 ${rival.crowdLabel}），故先处理`;
  }
  return `${head}且各分项完全相同，按固定区域顺序取${win.name}`;
}

function zoneIdFromTopic(topic) {
  const m = /^Airguard\/([^/]+)\/data$/i.exec(topic);
  return m ? m[1].toLowerCase() : null;
}

function pad2(n) {
  return String(n).padStart(2, '0');
}

/** 时间戳归一化为 HH:MM:SS，解析失败则退回原始字符串 */
function formatTime(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) {
      return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
    }
  }
  const raw = String(value).trim();
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(raw);
  if (m) return `${pad2(m[1])}:${pad2(m[2])}:${pad2(m[3] ?? 0)}`;
  return raw;
}

/** 任意时间写法 → Date；解析不出来返回 null（落盘与恢复共用同一个口径） */
function toDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    const d = new Date(value < 1e12 ? value * 1000 : value);   // 秒级 / 毫秒级都收
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const raw = String(value).trim();
  // 只给了时分秒（如 "16:10:01"）：按今天补日期，否则恢复出来的时间点会跨天漂移
  const t = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (t) {
    const d = new Date();
    d.setHours(Number(t[1]), Number(t[2]), Number(t[3] ?? 0), 0);
    return d;
  }
  const d = new Date(raw.replace(/\//g, '-').replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 时间戳归一化为 YYYY-MM-DD HH:MM:SS，落盘用；失败返回空串 */
function fmtStampFull(value) {
  const d = toDate(value);
  if (!d) return '';
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ` +
         `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

/** 落盘时间戳 → 毫秒；读不出来返回 null */
function parseStamp(s) {
  const d = toDate(s);
  return d ? d.getTime() : null;
}

function fmtNum(n, unit) {
  if (typeof n !== 'number') return '—';
  return `${Math.round(n)}${unit || ''}`;
}

function plainNum(n) {
  return typeof n === 'number' ? String(Math.round(n)) : '—';
}

/** 综合风险结论：取空气质量与人流两者中更严重的一方，必要时并列 */
function riskSummary(row) {
  const airLevel = LEVELS[row.level] || LEVELS.idle;
  const airBad = row.level !== 'good' && row.level !== 'idle';
  const flow = FLOW_LEVELS[row.crowdLevel];
  const flowBad = typeof row.crowdLevel === 'number' && row.crowdLevel >= 2;

  if (airBad && flowBad) return `${airLevel.label} · ${flow.label}`;
  if (airBad) return airLevel.label;
  if (flowBad) return flow.label;
  if (row.level === 'idle' && !flow) return '等待数据';
  return '正常';
}

/** 处置建议：空气质量建议 + 人流建议合并去重 */
function actionList(row) {
  const out = [];
  if (row.level !== 'good' && row.level !== 'idle') {
    out.push(...(LEVELS[row.level] || LEVELS.idle).actions);
  }
  if (typeof row.crowdLevel === 'number' && row.crowdLevel >= 2) {
    out.push(...(FLOW_ACTIONS[row.crowdLevel] || []));
  }
  if (!out.length) out.push(...(LEVELS[row.level] || LEVELS.idle).actions);
  return [...new Set(out)];
}

/* ==========================================================================
 * ③ 数据层 Store
 * --------------------------------------------------------------------------
 *  双通道防串区：主题里的 zoneId 与报文体里的 zoneId 必须同时有效且一致，
 *  否则整条报文丢弃并计数——避免一条脏数据污染错误的空间对象。
 *  status 一律按任务书规则本地重算，不信任发送端可能过期的字段。
 * ======================================================================== */

const Store = {
  zones: {},
  msgCount: 0,
  rejectCount: 0,
  lastAt: null,
  listeners: [],
  streaks: {},                        // zoneId → 末尾连续异常条数
  streakStart: {},                    // zoneId → 本轮连续异常首条记录的时刻（ms）
  perception: [],                     // 感知记录，最新在前，上限 PRIORITY_LIMIT
  priority: { rows: [], winner: null },   // 优先关注打分结果
  _perceptionSeq: {},                 // zoneId → 本次会话已产生的感知记录条数

  init() {
    this.streaks = {};
    this.streakStart = {};
    this.perception.length = 0;
    this._perceptionSeq = {};
    this.priority.rows = [];
    this.priority.winner = null;

    for (const b of BUILDINGS) {
      this.zones[b.id] = {
        reported: false,
        pm25: null,
        co2: null,
        crowdLevel: null,
        level: 'idle',
        timeText: '—',
        rawTime: null,
        cached: false,      // true = 从浏览器本地存储恢复的读数，尚未等到本次会话的报文
      };
    }
  },

  onChange(fn) {
    this.listeners.push(fn);
  },

  emit() {
    for (const fn of this.listeners) fn(this);
  },

  _reject() {
    this.rejectCount += 1;
    this.emit();
    return false;
  },

  /** @returns {boolean} 是否成功写入
   *  opts.cached = true 表示这是启动时从本地存储回灌的历史读数，不是本次会话收到的报文 */
  ingest(topicZoneId, payload, opts) {
    if (!payload || typeof payload !== 'object') return this._reject();

    const cached = !!(opts && opts.cached);

    const pick = makeKeyPicker(payload);
    const payloadZoneId = pick('zoneid');

    if (!this.zones[topicZoneId]) return this._reject();
    // 通道二：报文体的 zoneId 若存在且与主题不符，判定为串区
    if (
      payloadZoneId !== null &&
      payloadZoneId !== undefined &&
      String(payloadZoneId).toLowerCase() !== topicZoneId
    ) {
      return this._reject();
    }

    const pm25 = toNumber(pick('pm25'));
    const co2 = toNumber(pick('co2'));
    const crowdLevel = clampCrowd(toNumber(pick('crowdlevel')));

    // 环境维度至少要有一个有效读数才认可这条报文
    if (pm25 === null && co2 === null) return this._reject();

    const row = this.zones[topicZoneId];
    row.reported = true;
    row.pm25 = pm25;
    row.co2 = co2;
    row.crowdLevel = crowdLevel;
    row.level = evaluateLevel(pm25, co2);   // 本地重算，不使用报文里的 status
    row.rawTime = pick('time');
    row.timeText = formatTime(row.rawTime);
    // 解析成毫秒：持续时长要按报文时间戳做减法，字符串没法比
    row.ts = (toDate(row.rawTime) || new Date()).getTime();
    row.cached = cached;        // 一旦来了实时报文就自动脱掉缓存标记

    /* 连续异常计数：正常即归零。刷新页面后从头算起——
       缓存回灌只有每区域最后一条记录，「连续了几次」无从得知，按单次计。
       这是本模块已知的口径损耗：连续分只在页面存活期间累积。 */
    if (row.level === 'good') {
      this.streaks[topicZoneId] = 0;
      this.streakStart[topicZoneId] = null;
    } else if (cached) {
      /* 回放只知道「末尾这条是异常」，连续了几次、从哪一刻起都无从得知，
         按单次计，起点也只能记成这条自己 —— 时长自然是 0 */
      this.streaks[topicZoneId] = 1;
      this.streakStart[topicZoneId] = row.ts;
    } else {
      // 0 → 1 是本轮连续异常的起点，只有这一跳才写 streakStart
      if (!this.streaks[topicZoneId]) this.streakStart[topicZoneId] = row.ts;
      this.streaks[topicZoneId] = (this.streaks[topicZoneId] || 0) + 1;
    }

    /* 缓存回灌走同一条入库路径（标牌、灯带、面板的渲染逻辑只有一份），
       但它不是「刚收到的报文」，所以到此为止：不推进 lastAt、不计入 msgCount、
       不产生感知记录。否则每刷新一次页面，面板就会凭空多出一批消息数。 */
    if (cached) {
      this._computePriority();
      this.emit();
      return true;
    }

    this.msgCount += 1;
    this.lastAt = new Date();
    this._addPerception(topicZoneId, row);
    this._computePriority();
    this.emit();
    return true;
  },

  /** 感知记录：每条通过校验的报文派生一条，字段与另外四端一致。
   *  zoneId 由调用方传入——区域行本身不带 id 字段（见 init）。
   *  source 与 confidence 在本系统里没有真实来源，写死而不是留空，
   *  是为了让「这条记录是怎么来的」在界面上一眼可见。 */
  _addPerception(zoneId, row) {
    const n = (this._perceptionSeq[zoneId] || 0) + 1;
    this._perceptionSeq[zoneId] = n;
    this.perception.unshift({
      zoneId,
      // 真实系统里这里是抓拍图编号；本地没有图片，用「相机 + 区域 + 该区域第几条」
      // 拼出来，既能唯一标识，也比随机数好核对
      imageId: `cam-${zoneId}-${String(n).padStart(4, '0')}`,
      crowdLevel: crowdLabelOf(row.crowdLevel),
      confidence: null,
      source: PRIORITY_SOURCE,
      // 完整到日期：感知记录是存档性质的，只写 HH:MM:SS 跨天就没法核对了
      time: fmtStampFull(row.rawTime) || fmtStampFull(Date.now()),
    });
    if (this.perception.length > PRIORITY_LIMIT) {
      this.perception.length = PRIORITY_LIMIT;
    }
  },

  /** 按统一规则给三个区域打分，选出当前优先关注。
   *  就地改写 priority 的两个字段而不是换新对象：渲染层可能持有引用。 */
  _computePriority() {
    const rows = [];

    for (const b of BUILDINGS) {
      const z = this.zones[b.id];
      if (!z || !z.reported) continue;

      const streak = this.streaks[b.id] || 0;
      const env = streak === 0 ? 0
                : (streak === 1 ? PRIORITY_ENV_SINGLE : PRIORITY_ENV_STREAK);
      const crowd = crowdScore(z.crowdLevel);
      /* 持续时间只看本轮连续异常：末条记录时刻 − 首条记录时刻。
         streak 为 0 或 1 时首末同一条，时长 0 */
      const started = this.streakStart[b.id];
      const span = streak > 0 && started != null ? Math.max(0, z.ts - started) : 0;
      const row = {
        zoneId: b.id,
        name: b.name,
        streak,
        span,
        spanText: spanText(span),
        level: z.level,
        levelLabel: (LEVELS[z.level] || LEVELS.idle).label,
        env,
        crowd,
        crowdLabel: FLOW_LEVELS[crowd].short,
        total: env + crowd,
      };
      row.reason = priorityReason(row);
      rows.push(row);
    }

    /* 按 BUILDINGS 的固定顺序遍历。裁决链前四级全平时先到先得，等于
       「区域顺序」兜底，同一批数据算出来永远是同一个结果，不会来回跳。 */
    let winner = null;
    let rival = null;
    for (const r of rows) {
      if (!winner || comparePriority(r, winner) < 0) winner = r;
    }
    for (const r of rows) {
      if (r === winner) continue;
      if (!rival || comparePriority(r, rival) < 0) rival = r;
    }

    /* 全员 0 分 = 没有需要特别关注的区域，这本身就是结论，
       不该硬塞一个 0 分的区域上去凑数 */
    const top = winner && winner.total > 0 ? winner : null;
    if (top) top.verdict = priorityVerdict(top, rival);
    this.priority.rows = rows;
    this.priority.winner = top;
  },

  /** 供离线自测注入：等价于收到一条 MQTT 报文 */
  inject(zoneId, payload) {
    return this.ingest(String(zoneId).toLowerCase(), payload);
  },

  riskZones() {
    return BUILDINGS.filter((b) => {
      const r = this.zones[b.id];
      return r && r.reported && isRisk(r.level, r.crowdLevel);
    });
  },

  /** 缓存态区域数：用于在面板上说明「还有几个区域没等到本次会话的报文」 */
  cachedCount() {
    return BUILDINGS.filter((b) => {
      const r = this.zones[b.id];
      return r && r.reported && r.cached;
    }).length;
  },

  /** 清空全部实时状态，回到「等待 MQTT 推送」。
   *  逐字段就地改写而不是换新对象：标牌、灯带、交互面板可能持有 row 的引用。 */
  clearAll() {
    for (const b of BUILDINGS) {
      const row = this.zones[b.id];
      row.reported = false;
      row.pm25 = null;
      row.co2 = null;
      row.crowdLevel = null;
      row.level = 'idle';
      row.timeText = '—';
      row.rawTime = null;
      row.cached = false;
    }
    /* 连续异常与打分结果也一并归零：它们是从区域读数派生的，
       读数没了还留着上一个区域的连续分，面板上会自相矛盾 */
    this.streaks = {};
    this.streakStart = {};
    this._perceptionSeq = {};
    this.perception.length = 0;         // 就地清空：渲染层持有同一个数组
    this.priority.rows = [];
    this.priority.winner = null;

    this.msgCount = 0;
    this.rejectCount = 0;
    this.lastAt = null;
    this.emit();
  },
};

/* ==========================================================================
 * ④ 场景
 * ======================================================================== */

const stageEl = document.getElementById('stage');

const scene = new THREE.Scene();
scene.background = new THREE.Color(SCENE.sky);
scene.fog = new THREE.Fog(SCENE.sky, 72, 168);

const camera = new THREE.PerspectiveCamera(45, 1, 0.5, 420);
camera.position.copy(SCENE.cameraPos);

const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
stageEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.copy(SCENE.target);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.minDistance = SCENE.minDist;
controls.maxDistance = SCENE.maxDist;
controls.maxPolarAngle = Math.PI * 0.465;   // 不允许钻到地面之下
controls.minPolarAngle = Math.PI * 0.12;
controls.update();

/* --- 灯光 ---------------------------------------------------------------- */
scene.add(new THREE.AmbientLight(0xffffff, 2.35));

const sun = new THREE.DirectionalLight(0xffffff, 1.75);
sun.position.set(16, 30, 18);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1;
sun.shadow.camera.far = 95;
sun.shadow.camera.left = -26;
sun.shadow.camera.right = 26;
sun.shadow.camera.top = 26;
sun.shadow.camera.bottom = -26;
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
sun.target.position.set(0, 0, -3);
scene.add(sun, sun.target);

const fill = new THREE.DirectionalLight(0xdfe9f6, 0.55);
fill.position.set(-18, 14, -16);
scene.add(fill);

/* --- 浅灰色网格地面 ------------------------------------------------------ */
const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(420, 420),
  new THREE.MeshStandardMaterial({ color: '#f4f7fa', roughness: 1, metalness: 0 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);

const grid = new THREE.GridHelper(220, 110, 0x9fb2c6, 0xd2dbe5);
grid.position.y = 0.012;
grid.material.transparent = true;
grid.material.opacity = 0.85;
scene.add(grid);

/* ==========================================================================
 * ⑤ 楼宇搭建（原生基础几何体拼接，不加载外部模型）
 * ======================================================================== */

const boxGeo = new THREE.BoxGeometry(1, 1, 1);

/** 共享材质：本体、屋顶、窗户都是固定色，不随数据变化 */
const bodyMat = new THREE.MeshStandardMaterial({ color: BODY_COLOR, roughness: 0.82, metalness: 0.0 });
const roofMat = new THREE.MeshStandardMaterial({ color: ROOF_COLOR, roughness: 0.9, metalness: 0.0 });
const gearMat = new THREE.MeshStandardMaterial({ color: GEAR_COLOR, roughness: 0.85, metalness: 0.0 });
const paneMat = new THREE.MeshStandardMaterial({ color: PANE_COLOR, roughness: 0.34, metalness: 0.12 });
const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 20);

/** 地面光晕环贴图：中心透明、环带最亮、边缘归零 */
function makeHaloTexture() {
  const s = 256;
  const c = document.createElement('canvas');
  c.width = s;
  c.height = s;
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(s / 2, s / 2, s * 0.16, s / 2, s / 2, s * 0.5);
  g.addColorStop(0.0, 'rgba(255,255,255,0)');
  g.addColorStop(0.42, 'rgba(255,255,255,0.34)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.78)');
  g.addColorStop(0.80, 'rgba(255,255,255,0.26)');
  g.addColorStop(1.0, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
const haloTexture = makeHaloTexture();

/** 窗户排布：返回本栋楼全部窗格的 {位置, 尺寸} */
function windowLayout(spec) {
  const [w, h, d] = spec.size;
  const cfg = spec.window;
  const floorH = h / spec.floors;
  const out = [];

  // 四个立面：±Z（长边，沿 X 排布）与 ±X（短边，沿 Z 排布）
  const faces = [
    { axis: 'z', sign: 1, along: w },
    { axis: 'z', sign: -1, along: w },
    { axis: 'x', sign: 1, along: d },
    { axis: 'x', sign: -1, along: d },
  ];

  for (let f = 0; f < spec.floors; f++) {
    const y = (f + 0.5) * floorH;
    for (const face of faces) {
      const n = Math.max(2, Math.round(face.along / cfg.pitch));
      const cell = face.along / n;
      const paneW = cell * cfg.fill;
      const off = (face.axis === 'z' ? d : w) / 2 + 0.03;
      for (let i = 0; i < n; i++) {
        const t = -face.along / 2 + cell * (i + 0.5);
        if (face.axis === 'z') {
          out.push({ p: [t, y, face.sign * off], s: [paneW, cfg.h, 0.1] });
        } else {
          out.push({ p: [face.sign * off, y, t], s: [0.1, cfg.h, paneW] });
        }
      }
    }
  }
  return out;
}

/** 搭建一栋楼：本体 + 轮廓线 + 女儿墙 + 窗户 + 楼层环绕灯带 + 地面光晕环 */
function buildBuilding(spec) {
  const [w, h, d] = spec.size;
  const group = new THREE.Group();
  group.position.set(spec.pos[0], spec.pos[1], spec.pos[2]);

  const own = [];

  // --- 本体：固定浅灰白实体 ---
  const body = new THREE.Mesh(boxGeo, bodyMat);
  body.scale.set(w, h, d);
  body.position.y = h / 2;
  body.castShadow = true;
  body.receiveShadow = true;
  body.userData = { zoneId: spec.id, part: 'body' };
  group.add(body);
  own.push(body);

  // --- 轮廓线：悬浮时提亮，代替改变墙体颜色 ---
  const edges = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)),
    new THREE.LineBasicMaterial({ color: 0xc4ccd7, transparent: true, opacity: 0.9 })
  );
  edges.position.y = h / 2;
  group.add(edges);

  // --- 平顶女儿墙 ---
  const parapet = new THREE.Mesh(boxGeo, roofMat);
  parapet.scale.set(w + 0.18, 0.24, d + 0.18);
  parapet.position.y = h + 0.12;
  parapet.castShadow = true;
  parapet.receiveShadow = true;
  parapet.userData = { zoneId: spec.id, part: 'body' };
  group.add(parapet);
  own.push(parapet);

  // --- 窗户：一次 InstancedMesh 绘制完一栋楼的全部窗格 ---
  const panes = windowLayout(spec);
  const winMesh = new THREE.InstancedMesh(boxGeo, paneMat, panes.length);
  winMesh.castShadow = false;
  winMesh.receiveShadow = false;
  const mtx = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pv = new THREE.Vector3();
  const sv = new THREE.Vector3();
  panes.forEach((pane, i) => {
    pv.set(pane.p[0], pane.p[1], pane.p[2]);
    sv.set(pane.s[0], pane.s[1], pane.s[2]);
    mtx.compose(pv, q, sv);
    winMesh.setMatrixAt(i, mtx);
  });
  winMesh.instanceMatrix.needsUpdate = true;
  winMesh.userData = { zoneId: spec.id, part: 'body' };
  group.add(winMesh);
  own.push(winMesh);

  // --- 屋顶设备：水箱 / 机房等基础几何体，让平顶不是一个空白大板 ---
  for (const gear of spec.roof || []) {
    let mesh;
    if (gear.shape === 'cyl') {
      // size = [半径, 高]
      mesh = new THREE.Mesh(cylGeo, gearMat);
      mesh.scale.set(gear.size[0], gear.size[1], gear.size[0]);
      mesh.position.set(gear.pos[0], h + 0.24 + gear.size[1] / 2, gear.pos[2]);
    } else {
      mesh = new THREE.Mesh(boxGeo, gearMat);
      mesh.scale.set(gear.size[0], gear.size[1], gear.size[2]);
      mesh.position.set(gear.pos[0], h + 0.24 + gear.size[1] / 2, gear.pos[2]);
    }
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData = { zoneId: spec.id, part: 'roof' };
    group.add(mesh);
    own.push(mesh);
  }

  // --- 楼层环绕灯带 ---------------------------------------------------------
  //  整栋楼共用一个 material 实例 → 所有楼层颜色必然逐字节相同，
  //  数据结构本身即保证「同栋同色」这条硬性规则无法被破坏。
  const floorH = h / spec.floors;
  // fog:false —— 灯带必须逐字节等于设计色板，不能被距离雾稀释
  const bandMat = new THREE.MeshBasicMaterial({ color: FLOW_IDLE.color, toneMapped: false, fog: false });
  const bands = [];
  const bandW = w + 0.24;    // 每侧外挑 0.12，保证 45° 俯视下整圈可见
  const bandD = d + 0.24;
  const bandH = 0.22;
  for (let i = 0; i < spec.floors; i++) {
    const band = new THREE.Mesh(boxGeo, bandMat);
    band.scale.set(bandW, bandH, bandD);
    band.position.y = h - i * floorH - 0.13;   // 贴在每层楼板线下方
    band.userData = { zoneId: spec.id, part: 'band', floor: i };
    group.add(band);
    bands.push(band);
    own.push(band);
  }

  // --- 地面光晕环：风险处置中脉冲扩散 ---
  const halo = new THREE.Mesh(
    new THREE.PlaneGeometry(w * 1.85, d * 1.85),
    new THREE.MeshBasicMaterial({
      map: haloTexture,
      color: FLOW_IDLE.color,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
      fog: false,
    })
  );
  halo.rotation.x = -Math.PI / 2;
  halo.position.y = 0.03;
  halo.renderOrder = 2;
  halo.visible = false;
  group.add(halo);

  return {
    spec, group, body, edges, bands, halo,
    bandMat, bandW, bandD, bandH,
    pickables: own,
    phase: Math.random() * Math.PI * 2,
  };
}

const actors = {};
const pickables = [];
for (const spec of BUILDINGS) {
  const actor = buildBuilding(spec);
  actors[spec.id] = actor;
  pickables.push(...actor.pickables);
  scene.add(actor.group);
}

/* ==========================================================================
 * ⑥ 悬浮标签与发光标牌（DOM 投影到楼宇上方锚点）
 * --------------------------------------------------------------------------
 *  永久显示，页面加载即存在，无需鼠标触发。
 * ======================================================================== */

const tagEls = {};

function buildTags() {
  const layer = document.getElementById('tagLayer');
  for (const spec of BUILDINGS) {
    const el = document.createElement('div');
    el.className = 'bld-tag';
    el.dataset.zone = spec.id;

    const name = document.createElement('p');
    name.className = 'bld-name';
    name.textContent = spec.name;

    const code = document.createElement('p');
    code.className = 'bld-code';
    code.textContent = spec.code;

    // 悬浮发光标牌：承载空气质量
    const sign = document.createElement('div');
    sign.className = 'bld-sign';
    sign.dataset.level = 'idle';
    sign.dataset.pulse = '0';

    const dot = document.createElement('span');
    dot.className = 'bld-sign-dot';

    const text = document.createElement('span');
    text.className = 'bld-sign-text';
    text.textContent = LEVELS.idle.label;

    // 优先关注徽标：常态隐藏，整块标签挂上 .bld-priority 时才出现（见 ⑦ 节）
    const badge = document.createElement('span');
    badge.className = 'bld-priority-badge';
    badge.textContent = '优先关注';

    sign.append(dot, text);
    el.append(name, code, badge, sign);
    layer.appendChild(el);

    tagEls[spec.id] = { root: el, sign, dot, text, badge };
  }
}
buildTags();

/** 把三维锚点投影成屏幕像素，驱动标签层 */
const anchorVec = new THREE.Vector3();
function updateTagPositions() {
  const w = renderer.domElement.clientWidth;
  const h = renderer.domElement.clientHeight;
  for (const spec of BUILDINGS) {
    const t = tagEls[spec.id];
    if (!t) continue;
    anchorVec.set(spec.pos[0], spec.size[1] + spec.labelLift, spec.pos[2]).project(camera);
    if (anchorVec.z > 1) {
      t.root.style.visibility = 'hidden';
      continue;
    }
    t.root.style.visibility = 'visible';
    const x = (anchorVec.x * 0.5 + 0.5) * w;
    const y = (-anchorVec.y * 0.5 + 0.5) * h;
    t.root.style.transform = `translate3d(${x.toFixed(1)}px, ${y.toFixed(1)}px, 0) translate(-50%, -100%)`;
    t.root.style.zIndex = String(1000 - Math.round(anchorVec.z * 800));
  }
}

/* ==========================================================================
 * ⑦ 状态渲染：把 Store 的数据写进标牌、灯带与覆盖层
 * ======================================================================== */

/** 标牌颜色与脉冲开关（脉冲动画交给 CSS，JS 只负责语义） */
function updateSigns() {
  for (const spec of BUILDINGS) {
    const row = Store.zones[spec.id];
    const level = LEVELS[row.level] || LEVELS.idle;
    const t = tagEls[spec.id];
    if (!t) continue;

    t.sign.dataset.level = row.level;
    t.sign.dataset.pulse = level.pulse ? '1' : '0';
    t.sign.dataset.cached = row.reported && row.cached ? '1' : '0';
    t.sign.style.setProperty('--air-color', level.color);
    t.sign.style.setProperty('--air-ink', level.ink);
    t.sign.style.setProperty(
      '--pulse-dur',
      level.rank >= 3 ? '0.95s' : level.rank === 2 ? '1.25s' : '1.6s'
    );
    t.text.textContent = level.label;
  }
}

/** 灯带颜色（同栋同色）与地面光晕环脉冲 */
function updateFlow(t) {
  for (const spec of BUILDINGS) {
    const actor = actors[spec.id];
    if (!actor) continue;
    const row = Store.zones[spec.id];
    const flow = FLOW_LEVELS[row.crowdLevel] || FLOW_IDLE;
    const base = new THREE.Color(flow.color);

    /* 灯带只由人流等级决定 —— 这是硬性规则，优先关注不参与，
       否则「灯带颜色 = 人流」这条读图约定就被打破了 */
    if (flow.pulse) {
      const speed = flow.key >= 3 ? 2.6 : 2.0;
      const k = 0.5 + 0.5 * Math.sin(t * speed + actor.phase);   // 0 → 1
      // 只改明度、不动色相：深紫等低明度档位在暗态下也不能压到发黑
      actor.bandMat.color.copy(base).multiplyScalar(0.62 + 0.38 * k);
      const s = 1 + 0.028 * k;
      for (const band of actor.bands) {
        band.scale.set(actor.bandW * s, actor.bandH, actor.bandD * s);
      }
    } else {
      // 风险消除：恢复基础色，脉冲一并停止
      actor.bandMat.color.copy(base);
      for (const band of actor.bands) {
        band.scale.set(actor.bandW, actor.bandH, actor.bandD);
      }
    }

    /* 地面光晕环：人流风险脉冲 或 当前优先关注（橙色常亮）。
       优先关注区域即使人流平稳也有光晕——它的意义是「先看这里」，
       与人流是否告警无关，所以节奏比人流脉冲慢一档，两种语义分得开 */
    const isPriority = spec.id === priorityZoneId;
    if (flow.pulse || isPriority) {
      const speed = isPriority ? 1.6 : (flow.key >= 3 ? 2.6 : 2.0);
      const k = 0.5 + 0.5 * Math.sin(t * speed + actor.phase);
      actor.halo.visible = true;
      actor.halo.material.color.copy(isPriority ? PRIORITY_HALO : base);
      actor.halo.material.opacity = isPriority ? 0.20 + 0.32 * k : 0.16 + 0.42 * k;
      actor.halo.scale.setScalar(isPriority ? 1.06 + 0.10 * k : 1 + 0.08 * k);
      /* 地面实测 RGB 242/245/248，已经贴着白顶。加法混合往上加橙色（峰值约
         +59/+20/+4）会把三个通道一起顶到 255 —— 等于什么都没画。所以优先关注
         这一路改走普通混合，靠「把地面染暖」而不是「把地面提亮」来成像；
         人流脉冲那一路维持加法，行为不变 */
      actor.halo.material.blending = isPriority ? THREE.NormalBlending : THREE.AdditiveBlending;
    } else {
      actor.halo.visible = false;
      actor.halo.material.opacity = 0;
    }
  }
}

/* --- 优先关注在三维场景里的落点 ---------------------------------------------
 *  只动轮廓线与地面光晕，楼体本体仍然不变色（文件头的可视化分层约定）。
 *  轮廓线的写入方只有 repaintEdges 一个：优先关注的橙色与鼠标悬浮的深灰
 *  如果各写各的，先动鼠标的那次就会被后一次渲染覆盖掉。
 * -------------------------------------------------------------------------- */
let priorityZoneId = null;

function edgeColorFor(spec) {
  // 优先关注压过悬浮反馈：它是常驻标记，不该被一次划过就抹掉
  if (spec.id === priorityZoneId) return PRIORITY_EDGE;
  return spec.id === hoveredId ? EDGE_HOVER : EDGE_IDLE;
}

function repaintEdges() {
  for (const spec of BUILDINGS) {
    const actor = actors[spec.id];
    if (!actor) continue;
    const lit = spec.id === hoveredId || spec.id === priorityZoneId;
    actor.edges.material.color.set(edgeColorFor(spec));
    actor.edges.material.opacity = lit ? 1 : 0.9;
  }
}

/** 切换优先关注区域：轮廓线 + 悬浮标签徽标；null 表示当前没有优先关注 */
function applyPriorityHighlight(zoneId) {
  if (zoneId === priorityZoneId) return;
  priorityZoneId = zoneId;
  repaintEdges();
  for (const spec of BUILDINGS) {
    const t = tagEls[spec.id];
    if (t) t.root.classList.toggle('bld-priority', spec.id === zoneId);
  }
}

/** 当前优先关注横幅。文案与移动端两端逐字一致，方便对照排查 */
function renderPriority() {
  const banner = document.getElementById('priorityBanner');
  if (!banner) return;

  const pri = Store.priority;
  const win = pri.winner;

  // 还没有任何读数：整块不出现，页面顶部只留连接状态
  if (!pri.rows.length) {
    banner.hidden = true;
    applyPriorityHighlight(null);
    return;
  }

  banner.hidden = false;
  banner.dataset.focus = win ? 'yes' : 'no';

  document.getElementById('priorityTag').textContent = win ? '当前优先关注' : '持续风险';
  document.getElementById('priorityZone').textContent = win ? win.name : '暂无优先关注';
  document.getElementById('priorityTotalRow').hidden = !win;
  document.getElementById('priorityTotal').textContent = win ? String(win.total) : '';
  document.getElementById('prioritySplit').textContent = win
    ? `环境异常分 ${win.env} · 人流分 ${win.crowd}`
    : '各区域环境正常、人流稀疏，总分均为 0';

  const reason = document.getElementById('priorityReason');
  reason.textContent = win ? win.reason : '';
  reason.hidden = !win;

  const verdict = document.getElementById('priorityVerdict');
  verdict.textContent = win ? (win.verdict || '') : '';
  verdict.hidden = !win;

  applyPriorityHighlight(win ? win.zoneId : null);
}

/** 左下角图例 */
function renderLegend() {
  const air = document.getElementById('legendAir');
  const flow = document.getElementById('legendFlow');

  air.replaceChildren(
    ...['good', 'warning', 'serious', 'critical'].map((key) => {
      const lv = LEVELS[key];
      const li = document.createElement('li');
      li.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch legend-swatch--sign';
      sw.style.background = lv.color;
      const tx = document.createElement('span');
      tx.textContent = lv.label;
      li.append(sw, tx);
      return li;
    })
  );

  flow.replaceChildren(
    ...FLOW_LEVELS.map((fl) => {
      const li = document.createElement('li');
      li.className = 'legend-item';
      const sw = document.createElement('span');
      sw.className = 'legend-swatch legend-swatch--band';
      sw.style.background = fl.color;
      const tx = document.createElement('span');
      tx.textContent = `${fl.short}${fl.pulse ? ' · 脉冲' : ''}`;
      li.append(sw, tx);
      return li;
    })
  );
}

/** 右下角【区域实时监测】面板 + 顶部告警横幅 */
function renderDataPanel() {
  const host = document.getElementById('dataRows');
  host.replaceChildren(
    ...BUILDINGS.map((spec) => {
      const row = Store.zones[spec.id];
      const lv = LEVELS[row.level] || LEVELS.idle;
      const flow = FLOW_LEVELS[row.crowdLevel];
      const risky = row.reported && isRisk(row.level, row.crowdLevel);

      const el = document.createElement('div');
      el.className = 'data-row';
      el.dataset.level = row.level;

      const zone = document.createElement('span');
      zone.className = 'dr-zone';
      const b = document.createElement('b');
      b.textContent = spec.name;
      if (row.reported && row.cached) {
        const chip = document.createElement('span');
        chip.className = 'dr-cached';
        chip.textContent = '缓存';
        chip.title = '刷新前保存在本地的读数，等待 MQTT 推送新数据';
        b.append(chip);
      }
      const i = document.createElement('i');
      i.textContent = spec.code;
      zone.append(b, i);

      const pm = document.createElement('span');
      pm.className = 'dr-num';
      pm.textContent = plainNum(row.pm25);

      const co2 = document.createElement('span');
      co2.className = 'dr-num';
      co2.textContent = plainNum(row.co2);

      const crowd = document.createElement('span');
      crowd.className = 'dr-crowd';
      const cdot = document.createElement('i');
      cdot.className = 'dr-dot';
      cdot.style.background = flow ? flow.color : FLOW_IDLE.color;
      const ctext = document.createElement('span');
      ctext.textContent = flow ? flow.short : '待机';
      crowd.append(cdot, ctext);

      const status = document.createElement('span');
      status.className = 'dr-status';
      status.dataset.risk = risky ? '1' : '0';
      status.textContent = row.reported ? lv.label : '待机';

      el.append(zone, pm, co2, crowd, status);
      return el;
    })
  );

  document.getElementById('msgCount').textContent = String(Store.msgCount);
  document.getElementById('rejectCount').textContent = String(Store.rejectCount);

  const riskZones = Store.riskZones();
  const banner = document.getElementById('alertBanner');
  const chips = document.getElementById('alertChips');
  if (riskZones.length) {
    banner.hidden = false;
    banner.dataset.count = String(riskZones.length);
    chips.replaceChildren(
      ...riskZones.map((spec) => {
        const row = Store.zones[spec.id];
        const li = document.createElement('li');
        li.className = 'alert-chip';
        li.dataset.level = row.level;
        li.textContent = `${spec.name} · ${riskSummary(row)}`;
        return li;
      })
    );
  } else {
    banner.hidden = true;
    chips.replaceChildren();
  }
}

/** 图例与数据面板共用的那行状态说明 */
function panelNote() {
  const n = Store.riskZones().length;
  const base = Store.msgCount === 0 ? '等待 MQTT 数据…' : n ? `存在 ${n} 个风险区域` : '全部区域正常';

  const cachedN = Store.cachedCount();
  if (restoreInfo && cachedN) {
    return `已恢复 ${restoreInfo.count} 条本地历史 · ${cachedN} 个区域为缓存读数` +
           `（${restoreInfo.lastStamp}）· ${base}`;
  }
  // 清空后的回执：一旦收到实时报文（msgCount > 0）就自动让位给正常状态说明
  if (overrideNote && Store.msgCount === 0) return `${overrideNote} · ${base}`;
  return base;
}

/** 数据到达后统一刷新覆盖层 */
function renderAll() {
  updateSigns();
  renderDataPanel();
  renderPriority();

  const last = Store.lastAt;
  document.getElementById('clockTime').textContent = last
    ? `${pad2(last.getHours())}:${pad2(last.getMinutes())}:${pad2(last.getSeconds())}`
    : '--:--:--';

  const note = panelNote();
  document.getElementById('legendNote').textContent = note;
  document.getElementById('dataNote').textContent = note;
}

/* 启动序列在文件末尾（⑩ 节）：本地持久化模块用的是 const / let 绑定，
   在那一段求值之前调用会踩到暂时性死区。 */

/* ==========================================================================
 * ⑧ 交互：悬浮拾取 + 信息面板
 * ======================================================================== */

const tipEl = document.getElementById('tip');
let hoveredId = null;

const ray = new THREE.Raycaster();
const ptr = new THREE.Vector2();
let ptrPx = { x: 0, y: 0 };

/** 悬浮信息面板内容 */
function fillTip(zoneId) {
  const spec = BUILDINGS.find((b) => b.id === zoneId);
  const row = Store.zones[zoneId];
  if (!spec || !row) return;
  const lv = LEVELS[row.level] || LEVELS.idle;
  const flow = FLOW_LEVELS[row.crowdLevel] || FLOW_IDLE;

  document.getElementById('tipName').textContent = spec.name;
  document.getElementById('tipId').textContent = spec.code;
  document.getElementById('tipSwatch').style.background = lv.color;
  document.getElementById('tipSignDot').style.background = lv.color;
  document.getElementById('tipBandDot').style.background = flow.color;

  document.getElementById('tipPm25').textContent = fmtNum(row.pm25, ' μg/m³');
  document.getElementById('tipCo2').textContent = fmtNum(row.co2, ' ppm');
  document.getElementById('tipCrowd').textContent =
    `${flow.label}${typeof row.crowdLevel === 'number' ? `（${row.crowdLevel}）` : ''}`;
  document.getElementById('tipRisk').textContent = row.reported ? riskSummary(row) : '等待数据';
  document.getElementById('tipTime').textContent = row.timeText;

  document.getElementById('tipActions').replaceChildren(
    ...actionList(row).map((a) => {
      const li = document.createElement('li');
      li.textContent = a;
      return li;
    })
  );

  tipEl.dataset.level = row.level;
  tipEl.style.setProperty('--air-color', lv.color);
  tipEl.style.setProperty('--air-ink', lv.ink);
}

/**
 * 面板的「禁区」集合：三栋楼的永久标签与空气质量标牌，以及四块 HUD 面板。
 * 标签始终悬浮在楼顶上方，面板一旦向上翻转就会正好盖住它们；
 * 而面板正文正是在解释「标牌＝空气质量、灯带＝人流」——盖住标牌等于自相矛盾。
 */
const AVOID_SELECTORS = ['.topbar', '.alert-banner', '.legend', '.data-panel'];

function avoidRects() {
  const out = [];
  const push = (r, pad) => out.push({ x0: r.left - pad, y0: r.top - pad, x1: r.right + pad, y1: r.bottom + pad });

  for (const spec of BUILDINGS) {
    const t = tagEls[spec.id];
    if (t && t.root.style.visibility !== 'hidden') push(t.root.getBoundingClientRect(), 8);
  }
  for (const sel of AVOID_SELECTORS) {
    const el = document.querySelector(sel);
    if (!el || el.hidden || getComputedStyle(el).display === 'none') continue;
    push(el.getBoundingClientRect(), 6);
  }
  return out;
}

function placeTip() {
  const pad = 14;
  const gap = 22;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const w = tipEl.offsetWidth;
  const h = tipEl.offsetHeight;
  const avoid = avoidRects();

  // 光标四角依次试探：右下 → 左下 → 右上 → 左上
  const cands = [];
  for (const dy of [18, -h - 18]) {
    for (const dx of [gap, -w - gap]) cands.push([ptrPx.x + dx, ptrPx.y + dy]);
  }
  // 窄缝兜底：两栋楼的标签在水平方向就可能重叠，四角全被夹死时
  // 逐级把面板往外推，直到挤进一片干净区域
  for (const push of [40, 90, 160, 250, 360]) {
    for (const dy of [18, -h - 18]) {
      for (const dx of [gap, -w - gap]) {
        cands.push([ptrPx.x + dx + Math.sign(dx) * push, ptrPx.y + dy + Math.sign(dy) * push]);
      }
    }
  }

  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);
  const blocked = (x, y) =>
    avoid.some((a) => x < a.x1 && x + w > a.x0 && y < a.y1 && y + h > a.y0);

  let roomy = null;   // 既不出屏、又不压任何东西
  let free = null;    // 只保证不压东西（必要时贴边）
  for (const [cx, cy] of cands) {
    const x = clamp(cx, pad, vw - w - pad);
    const y = clamp(cy, pad, vh - h - pad);
    if (blocked(x, y)) continue;
    free = free || { x, y };
    if (x === cx && y === cy) { roomy = { x, y }; break; }
  }

  const x0 = clamp(cands[0][0], pad, vw - w - pad);
  const y0 = clamp(cands[0][1], pad, vh - h - pad);
  const pick = roomy || free || { x: x0, y: y0 };
  tipEl.style.transform = `translate3d(${pick.x}px, ${pick.y}px, 0)`;
}

function setHover(zoneId) {
  if (zoneId === hoveredId) return;
  hoveredId = zoneId;

  // 悬浮反馈作用在轮廓线上，不改变楼体本身颜色。
  // 实际配色交给 repaintEdges 统一裁决：优先关注区域保持橙色，不被划过抹掉。
  repaintEdges();

  if (zoneId) {
    fillTip(zoneId);
    tipEl.hidden = false;
    placeTip();
  } else {
    tipEl.hidden = true;
  }
}

function pickAt(clientX, clientY) {
  const rect = renderer.domElement.getBoundingClientRect();
  ptr.x = ((clientX - rect.left) / rect.width) * 2 - 1;
  ptr.y = -((clientY - rect.top) / rect.height) * 2 + 1;
  ray.setFromCamera(ptr, camera);
  const hits = ray.intersectObjects(pickables, false);
  return hits.length ? hits[0].object.userData.zoneId : null;
}

renderer.domElement.addEventListener('pointermove', (e) => {
  ptrPx = { x: e.clientX, y: e.clientY };
  if (e.buttons !== 0) {              // 拖拽旋转时不做拾取
    setHover(null);
    return;
  }
  setHover(pickAt(e.clientX, e.clientY));
  if (hoveredId) {
    fillTip(hoveredId);
    placeTip();
  }
});

renderer.domElement.addEventListener('pointerleave', () => setHover(null));

// 数据刷新时同步更新已展开的面板
Store.onChange(() => {
  renderAll();
  if (hoveredId) {
    fillTip(hoveredId);
    placeTip();
  }
});

/* ==========================================================================
 * ⑨ 本地持久化：报文落盘 → 刷新 / 重开自动恢复 → 一键清空
 * --------------------------------------------------------------------------
 *  记录只存「收到过什么」，字段与 Web 大屏导出的 CSV 表头一致：
 *      time, zone, pm25, co2, crowdLevel, status
 *  本页面不提供 CSV 导出（导出只在 Web 监测台），这里落盘是为了刷新之后
 *  沙盘不至于一张白纸重来，也让「清空本地记录」有确切的清除对象。
 *
 *  存储键与 Web 大屏、移动端各自独立：三个页面可能同源，共用一个键会互相覆盖。
 * ======================================================================== */

const HISTORY = {
  key: 'airguard.history.map3d.v1',
  limit: 5000,       // 最多保留 5000 条，超出丢最旧的
  debounceMs: 400,   // 写入节流，见 scheduleSave 的说明
};

/** 全部历史记录；与 window.historyRecords 始终指向同一个数组 */
const historyRecords = (window.historyRecords = []);

/** 启动时恢复到的记录条数与最新时间戳，用于在面板上说明数据来源 */
let restoreInfo = null;

/** 清空后的一次性提示，收到下一条实时报文即自动让位 */
let overrideNote = null;

/* 无痕模式 / 禁用站点数据 / 部分 file:// 场景下取用 localStorage 会直接抛异常。
   先探测一次，不可用就整体降级为「只存内存」，沙盘其余功能照常运行。 */
const storageOk = (() => {
  try {
    const probe = '__airguard_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return true;
  } catch (e) {
    console.warn('[AirGuard] 本地存储不可用，历史记录只保留在内存中：', e && e.message);
    return false;
  }
})();

/** 一条记录至少要有时间和区域，否则恢复时定位不到任何楼宇 */
function isValidRecord(r) {
  return !!r && typeof r === 'object' &&
         typeof r.time === 'string' && r.time &&
         typeof r.zone === 'string' && r.zone;
}

/** 报文 → 落盘记录
 *  按报文原值存档，不四舍五入也不 clamp：记录是「收到过什么」的存档，
 *  与页面上经过归一化的展示值分开算。status 存上报值，不存本地重算结果。 */
function toRecord(zoneId, payload) {
  const pick = makeKeyPicker(payload);
  const time = pick('time');
  const status = pick('status');
  return {
    // 报文没带时间就用本地接收时刻补上，否则恢复时整条记录没有落点
    time: (time === null || time === undefined || time === '')
      ? fmtStampFull(Date.now())
      : String(time),
    zone: zoneId,
    pm25: toNumber(pick('pm25')),
    co2: toNumber(pick('co2')),
    crowdLevel: toNumber(pick('crowdlevel')),
    status: (status === null || status === undefined) ? '' : String(status),
  };
}

/** 超出上限时丢最旧的。写入前和推入后都调，内存和存档不会各自漂移。 */
function trimHistory() {
  const over = historyRecords.length - HISTORY.limit;
  if (over > 0) historyRecords.splice(0, over);
}

function loadHistory() {
  if (!storageOk) return [];
  let raw;
  try {
    raw = window.localStorage.getItem(HISTORY.key);
  } catch {
    return [];
  }
  if (!raw) return [];

  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    // 逐条校验：存储可能被手工改过，或来自旧版本的结构
    return arr.filter(isValidRecord).slice(-HISTORY.limit);
  } catch (e) {
    console.warn('[AirGuard] 本地历史不是合法 JSON，已忽略：', e && e.message);
    return [];
  }
}

function saveHistory() {
  if (!storageOk) return;
  trimHistory();
  try {
    window.localStorage.setItem(HISTORY.key, JSON.stringify(historyRecords));
    return;
  } catch (e) {
    // 配额写满：丢掉一半最旧的再试一次。存档失败不该影响实时监测，所以不往上抛。
    console.warn('[AirGuard] 本地存储写入失败，丢弃最旧的记录后重试：', e && e.message);
  }
  historyRecords.splice(0, Math.ceil(historyRecords.length / 2));
  try {
    window.localStorage.setItem(HISTORY.key, JSON.stringify(historyRecords));
  } catch (e2) {
    console.error('[AirGuard] 本地存储仍无法写入，本次存档跳过：', e2 && e2.message);
  }
}

let saveTimer = null;

/* 每条报文都同步写一次 localStorage 会阻塞主线程（JSON.stringify + 磁盘写，
   三栋楼连着上报时渲染循环会卡顿），所以攒一小段时间再写。
   页面隐藏 / 关闭时补一次，保证不丢最后几百毫秒内的数据。 */
function scheduleSave() {
  if (!storageOk || saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveHistory();
  }, HISTORY.debounceMs);
}

function flushSave() {
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  saveHistory();
}

window.addEventListener('pagehide', flushSave);
window.addEventListener('beforeunload', flushSave);

/* 启动时把本地记录回灌成沙盘状态：
     ① historyRecords —— 清空操作的计数对象
     ② 每栋楼最后一次读数 —— 走 Store.ingest 的 cached 分支
   全程不推进 lastAt、不计消息数、不触发风险横幅，它们是历史，不是刚收到的报文。 */
function restoreHistory() {
  const saved = loadHistory();
  if (!saved.length) return 0;

  // 就地改写而不是 historyRecords = saved：
  // window.historyRecords 必须与内部数组始终是同一个引用
  historyRecords.length = 0;
  historyRecords.push(...saved);

  // 每栋楼取「最后一条带有效读数的记录」。全空的记录回灌进去会被 ingest
  // 判为无效，反而把「串区拦截」计数刷上去。
  const lastByZone = new Map();
  let lastTs = 0;
  for (const rec of saved) {
    if (toNumber(rec.pm25) === null && toNumber(rec.co2) === null) continue;
    lastByZone.set(rec.zone, rec);
    const ts = parseStamp(rec.time);
    if (ts !== null && ts > lastTs) lastTs = ts;
  }

  let restored = 0;
  for (const spec of BUILDINGS) {
    const rec = lastByZone.get(spec.id);
    if (rec && Store.ingest(spec.id, rec, { cached: true })) restored += 1;
  }

  restoreInfo = {
    count: saved.length,
    lastStamp: lastTs ? fmtStampFull(lastTs).slice(5) : '未知',   // 去掉年份，面板放得下
  };
  console.info(`[AirGuard] 已从本地存储恢复 ${saved.length} 条历史记录，回灌 ${restored} 栋楼宇`);
  return saved.length;
}

/** 清空本地记录：内存 + 本地存储一起清，沙盘回到「等 MQTT 推送」 */
function clearHistory() {
  if (!window.confirm(
    '确定清空本地保存的全部历史记录？\n\n' +
    `将删除已保存的 ${historyRecords.length} 条记录，并把沙盘恢复到等待状态。此操作不可撤销。`
  )) {
    return;
  }

  historyRecords.length = 0;
  restoreInfo = null;
  overrideNote = '本地记录已清空';
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }

  if (storageOk) {
    try {
      window.localStorage.removeItem(HISTORY.key);
    } catch (e) {
      console.warn('[AirGuard] 清除本地存储失败：', e && e.message);
    }
  }

  Store.clearAll();          // 就地清空并触发重渲染
  console.info('[AirGuard] 已清空本地记录');
}

/* ==========================================================================
 * ⑩ MQTT 接入 · 渲染循环 · 启动
 * ======================================================================== */

function setConnState(state, text) {
  document.getElementById('statusbar').dataset.conn = state;
  document.getElementById('connText').textContent = text;
}

function connectMQTT() {
  if (typeof window.mqtt === 'undefined') {
    setConnState('error', 'mqtt.js 未加载');
    return;
  }

  setConnState('connecting', '连接中…');
  const client = window.mqtt.connect(MQTT_CONFIG.url, {
    clientId: `airguard-3d-${Math.random().toString(16).slice(2, 10)}`,
    keepalive: MQTT_CONFIG.keepalive,
    reconnectPeriod: MQTT_CONFIG.reconnectPeriod,
    connectTimeout: MQTT_CONFIG.connectTimeout,
    clean: true,
  });

  client.on('connect', () => {
    setConnState('online', '已连接');
    client.subscribe(MQTT_CONFIG.topic, { qos: MQTT_CONFIG.qos }, (err) => {
      if (err) setConnState('error', '订阅失败');
    });
  });

  client.on('reconnect', () => setConnState('connecting', '重连中…'));
  client.on('close', () => setConnState('offline', '已断开'));
  client.on('error', () => setConnState('error', '连接异常'));

  client.on('message', (topic, payload) => {
    const zoneId = zoneIdFromTopic(topic);
    if (!zoneId) return;
    let data = null;
    try {
      data = JSON.parse(payload.toString());
    } catch {
      data = null;                      // 非法报文走统一的丢弃计数
    }
    // 入库成功才记账：被丢弃的报文不进历史，否则存档里混着假数据
    if (Store.ingest(zoneId, data)) {
      historyRecords.push(toRecord(zoneId, data));
      scheduleSave();     // 节流写回本地存储，见 ⑨ 节
    }
  });

  window.__airguardMqtt = client;
}

function resize() {
  const w = stageEl.clientWidth || window.innerWidth;
  const h = stageEl.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

/* --- 启动序列 ---------------------------------------------------------------
 *  顺序不能调换：先建好空状态，再回灌本地历史（它会走 Store.ingest 的
 *  cached 分支把标牌与灯带点亮），最后整体渲染一次。
 * -------------------------------------------------------------------------- */
Store.init();
renderLegend();
restoreHistory();
renderAll();

const clearBtn = document.getElementById('clearHistory');
if (clearBtn) clearBtn.addEventListener('click', clearHistory);

window.addEventListener('resize', resize);
resize();

const clock = new THREE.Clock();
function loop() {
  requestAnimationFrame(loop);
  updateFlow(clock.getElapsedTime());
  controls.update();
  renderer.render(scene, camera);
  updateTagPositions();
}
loop();

connectMQTT();

/* ==========================================================================
 * 调试 / 自动化测试钩子
 * ======================================================================== */

window.__airguard3d = {
  THREE, scene, camera, renderer, controls, Store,
  BUILDINGS, LEVELS, FLOW_LEVELS, FLOW_IDLE, actors, pickables, tagEls,
  haloTexture,
  samples: null,

  /* 持续风险与优先关注：打分结果、感知记录与当前高亮区域。
     内存态，不落盘，刷新即重来（见 ③ 节的连续异常计数说明）。 */
  priority: {
    source: PRIORITY_SOURCE,
    envSingle: PRIORITY_ENV_SINGLE,
    envStreak: PRIORITY_ENV_STREAK,
    limit: PRIORITY_LIMIT,
    accent: PRIORITY_ACCENT,
    rows: () => Store.priority.rows,
    winner: () => Store.priority.winner,
    streaks: () => Store.streaks,
    streakStart: () => Store.streakStart,
    spanText,
    perception: () => Store.perception,
    highlighted: () => priorityZoneId,
  },

  /** 本地持久化：自动化测试与手工排查用 */
  history: {
    key: HISTORY.key,
    limit: HISTORY.limit,
    available: storageOk,
    records: historyRecords,
    info: () => restoreInfo,
    load: loadHistory,
    save: flushSave,
    restore: restoreHistory,
    clear: clearHistory,
  },

  inject(zoneId, payload) {
    return Store.inject(zoneId, payload);
  },

  /** 世界坐标 → 屏幕像素 */
  toScreen(points) {
    const rect = renderer.domElement.getBoundingClientRect();
    const out = {};
    for (const [k, p] of Object.entries(points)) {
      const v = new THREE.Vector3(p[0], p[1], p[2]).project(camera);
      out[k] = {
        x: (v.x * 0.5 + 0.5) * rect.width,
        y: (-v.y * 0.5 + 0.5) * rect.height,
        z: v.z,
      };
    }
    return out;
  },

  /** 指定世界坐标点，下一帧渲染后回读 3×3 邻域像素均值 */
  probe(points) {
    const pts = this.toScreen(points);
    const gl = renderer.getContext();
    const dpr = renderer.getPixelRatio();
    const H = renderer.domElement.height;
    const W = renderer.domElement.width;
    requestAnimationFrame(() => {
      const out = {};
      const buf = new Uint8Array(4);
      for (const [k, p] of Object.entries(pts)) {
        const cx = Math.round(p.x * dpr);
        const cy = Math.round(H - p.y * dpr);
        let r = 0, g = 0, b = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            const px = cx + dx;
            const py = cy + dy;
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            r += buf[0]; g += buf[1]; b += buf[2]; n += 1;
          }
        }
        out[k] = n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
      }
      window.__airguard3d.samples = out;
    });
    return pts;
  },

  /**
   * 细窄高饱和构件（楼层灯带）的采色：在 (2r+1)² 窗口里取色度最高的那个像素。
   * 灯带在默认机位下只有几个像素高，邻域均值会被两侧墙面冲淡，
   * 取「窗口内最饱和的像素」才能还原它真正渲染出的颜色。
   */
  probeSharp(points, r = 3) {
    const pts = this.toScreen(points);
    const gl = renderer.getContext();
    const dpr = renderer.getPixelRatio();
    const H = renderer.domElement.height;
    const W = renderer.domElement.width;
    requestAnimationFrame(() => {
      const out = {};
      const buf = new Uint8Array(4);
      for (const [k, p] of Object.entries(pts)) {
        const cx = Math.round(p.x * dpr);
        const cy = Math.round(H - p.y * dpr);
        let best = null;
        let bestChroma = -1;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            const px = cx + dx;
            const py = cy + dy;
            if (px < 0 || py < 0 || px >= W || py >= H) continue;
            gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, buf);
            const chroma = Math.max(buf[0], buf[1], buf[2]) - Math.min(buf[0], buf[1], buf[2]);
            if (chroma > bestChroma) {
              bestChroma = chroma;
              best = [buf[0], buf[1], buf[2]];
            }
          }
        }
        out[k] = best;
      }
      window.__airguard3d.samples = out;
    });
    return pts;
  },
};
