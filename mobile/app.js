/* ============================================================
   AirGuard 校园多区域空气质量与人流监测预警协同系统 · 移动巡检端
   微信小程序 · 应用级：MQTT 客户端 + 共享实时状态
   ------------------------------------------------------------
   数据链路：
       感知采集节点 → MQTT/JSON → 共享实时状态 → Web 监测大屏
                                                → 移动巡检端（本小程序）
                                                → 地图 / 3D

   关于 MQTT 的实现方式：
   微信小程序没有内置 MQTT API，也无法运行 mqtt.js（依赖 Node 的
   stream / Buffer / events）。这里用小程序自带的 wx.connectSocket
   建立 WebSocket，再手写 MQTT 3.1.1 报文编解码（CONNECT / SUBSCRIBE
   / PUBLISH / PINGREQ / DISCONNECT），零 npm 依赖，导入开发者工具即可运行。

   本文件分四段：
     ① 常量表        ② MQTT 报文编解码（纯函数）
     ③ 业务纯函数     ④ MqttClient + App 实例
   前两段全部是纯函数、不碰小程序 API，可以直接在 Node 里跑了做协议验证。
   ============================================================ */

/* ============================================================
   ① 常量表
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
   与 Web 大屏 / 移动端浏览器版 / 地图3D / 分析报告用的是同一套规则，
   改动必须五处同步：

     总分 = 环境异常分 + 人流分
     环境异常分：末尾连续异常 0 条 = 0；1 条 = 1（单次异常）；≥2 条 = 3（连续多次异常）
     人流分：稀疏 0 / 正常 1 / 拥挤 2 / 严重拥挤 3

   取总分最高者为【当前优先关注】，平分依次比环境分、人流分，
   再按 ZONES 的固定顺序兜底，保证同一批数据永远算出同一个结果。
   ------------------------------------------------------------ */
var PRIORITY_ENV_SINGLE = 1;     // 单次异常
var PRIORITY_ENV_STREAK = 3;     // 连续多次异常
var PRIORITY_SOURCE = 'review';  // 感知记录来源，全系统固定；confidence 固定为 null
var PERCEPTION_LIMIT = 30;       // 感知记录在内存里保留的条数（不落盘，仅用于本次会话）

/* 感知记录编号：zoneId → 本次会话该区域已产生的条数（imageId 里的序号） */
var perceptionSeq = {};

/* 人流分：缺失或超出 0–3 的取值一律夹到范围内再打分 —— 打分要的是一个确定的数，
   而卡片上的感知结论仍然如实显示原始取值（见 parseReading 里的 crowdText） */
function crowdScore(v) {
  if (v === null || v === undefined || !isFinite(v)) return 0;
  var n = Math.round(v);
  return n < 0 ? 0 : (n > 3 ? 3 : n);
}

/* ------------------------------------------------------------
   D3 干预—验证—恢复
   与 Web 大屏 / 移动端浏览器版 / 地图3D 逐字同源的常量与规则。
   四端各有一份实现，靠同一套确定性规则 + MQTT 干预广播收敛到同一状态，
   所以这里任何一个数改了都必须四处同步。
   ------------------------------------------------------------ */
var EV_OPEN = 'OPEN';           // 待处理：监测捕获异常，等管理员干预
var EV_HANDLING = 'HANDLING';   // 处理中：已提交干预，等新监测数据验证
var EV_RECOVERED = 'RECOVERED'; // 已恢复：连续达标数据自动判定，之后不再回滚

var EV_RELAPSE_SAMPLES = 2;     // 干预后连续 2 组数据比干预时更严重 → 回退待处理
var EV_CONFIDENCE_FLOOR = 0.6;  // 低于此值视为低可信度感知数据
var EV_DEDUPE_MAX = 500;        // 去重键保留上限
var EV_LOG_MAX = 40;            // 单个事件保留的日志条数

/* 干预动作：卡片上多选。环境异常按等级取一组，人流拥挤按 2 / 3 档取一组,
   选项文字与任务书逐字一致 */
var EV_ACTIONS = {
  warning:  ['开启低档位新风', '广播提醒开窗通风', '安排教室巡检'],
  critical: ['全开新风+喷雾降尘', '关闭外窗', '暂停大型聚集活动'],
  serious:  ['开启教室新风换气机组', '课间开窗提醒', '延长排风扇工作时间'],
  crowd2:   ['安排人员走廊分流', '大屏错峰下课提示', '开放备用通道'],
  crowd3:   ['区域入口限流', '广播引导疏散', '上报值班老师']
};

var EV_LABEL = {
  OPEN: 'OPEN 待处理',
  HANDLING: 'HANDLING 处理中',
  RECOVERED: 'RECOVERED 已恢复'
};

/* 事件表只活在内存里，不落盘：重进页面即回到初始态，由新收到的报文重新建立。
   这里只留内存上限 —— 它不参与任何存储键，【清空本地记录】也无事可做 */
var EVENTS = {
  limit: 50                     // 事件表最多留 50 条，超出丢最旧的
};

/* 去重表：数组保序（用来淘汰最旧的键），对象做 O(1) 命中判断 */
var seenKeys = [];
var seenSet = {};

/* 事件序号：event_id 里的自增段，恢复存档时按已有的最大值接着往下发 */
var eventSeq = 0;

var MQTT_CONFIG = {
  /* 公网 Broker（EMQX 公共服务）：四端和 MQTTX 都连它，手机在任何网络（4G/别的 WiFi）
     都能收到数据，不再要求「手机和电脑同一局域网」。
     注意：各端必须落在同一个 Broker 上，否则数据不互通，所以这里只放一条地址；
     真连不上时再往 candidates 里补候选（探测逻辑仍在，超过 1 条才会启用）。 */
  candidates: [
    'wss://broker.emqx.io:8084/mqtt'   // 公网 WSS，path 必须是 /mqtt
  ],
  url: 'wss://broker.emqx.io:8084/mqtt',   // 探测命中后会被改写成实际可用的那条，状态栏显示的就是它
  probeTimeout: 4000,           // 单个候选地址探测超时（毫秒），到点没连上就换下一个
  protocol: 'mqtt',             // WebSocket 子协议；EMQX 要求必须带上
  topic: 'Airguard-x9k2m/+/data',     // + 为区域通配符
  /* D3 干预广播：与数据流共用同一条连接，靠主题前缀分流。
     Airguard-x9k2m/+/data 收不到它 —— 那个过滤器要求第 3 段是 data，
     而干预主题的第 3 段是区域 ID（Airguard-x9k2m/intervention/zone-n） */
  interventionTopic: 'Airguard-x9k2m/intervention/+',
  interventionPrefix: 'Airguard-x9k2m/intervention/',
  qos: 0,
  keepalive: 30,                // 秒
  reconnectPeriod: 3000         // 断线后每 3 秒重连
};

/* ============================================================
   ② MQTT 3.1.1 报文编解码（纯函数，不依赖小程序 API）
   ============================================================ */

/* UTF-8 编码：string → 字节数组 */
function utf8Encode(str) {
  var bytes = [];
  for (var i = 0; i < str.length; i++) {
    var c = str.charCodeAt(i);
    if (c < 0x80) {
      bytes.push(c);
    } else if (c < 0x800) {
      bytes.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    } else if (c >= 0xd800 && c <= 0xdbff && i + 1 < str.length) {
      var c2 = str.charCodeAt(i + 1);
      if (c2 >= 0xdc00 && c2 <= 0xdfff) {
        // 代理对 → 4 字节
        var cp = 0x10000 + ((c - 0xd800) << 10) + (c2 - 0xdc00);
        bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f),
                   0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
        i++;
      } else {
        bytes.push(0xef, 0xbf, 0xbd);   // 非法代理项 → U+FFFD
      }
    } else {
      bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    }
  }
  return bytes;
}

/* UTF-8 解码：字节数组 [start, end) → string */
function utf8Decode(buf, start, end) {
  var out = '';
  var i = start;
  while (i < end) {
    var b = buf[i];
    var cp;
    if (b < 0x80) {
      cp = b; i += 1;
    } else if ((b & 0xe0) === 0xc0 && i + 1 < end) {
      cp = ((b & 0x1f) << 6) | (buf[i + 1] & 0x3f); i += 2;
    } else if ((b & 0xf0) === 0xe0 && i + 2 < end) {
      cp = ((b & 0x0f) << 12) | ((buf[i + 1] & 0x3f) << 6) | (buf[i + 2] & 0x3f); i += 3;
    } else if ((b & 0xf8) === 0xf0 && i + 3 < end) {
      cp = ((b & 0x07) << 18) | ((buf[i + 1] & 0x3f) << 12) |
           ((buf[i + 2] & 0x3f) << 6) | (buf[i + 3] & 0x3f); i += 4;
    } else {
      cp = 0xfffd; i += 1;              // 非法字节 → U+FFFD
    }
    if (cp > 0xffff) {
      cp -= 0x10000;
      out += String.fromCharCode(0xd800 + (cp >> 10), 0xdc00 + (cp & 0x3ff));
    } else {
      out += String.fromCharCode(cp);
    }
  }
  return out;
}

/* 剩余长度（Remaining Length）变长整数编码 */
function encodeLength(len) {
  var out = [];
  do {
    var b = len % 128;
    len = Math.floor(len / 128);
    if (len > 0) b |= 0x80;
    out.push(b);
  } while (len > 0);
  return out;
}

/* 按「固定头 + 可变头 + 载荷」拼一个完整报文 */
function buildPacket(headerByte, body) {
  var bytes = [headerByte].concat(encodeLength(body.length), body);
  var u8 = new Uint8Array(bytes.length);
  for (var i = 0; i < bytes.length; i++) u8[i] = bytes[i];
  return u8.buffer;
}

/* CONNECT：协议名 MQTT / 协议级别 4 / Clean Session / Keep Alive / ClientId */
function buildConnect(clientId, keepalive) {
  var id = utf8Encode(clientId);
  var body = [
    0x00, 0x04, 0x4d, 0x51, 0x54, 0x54,   // 长度前缀 + "MQTT"
    0x04,                                  // 协议级别 4（MQTT 3.1.1）
    0x02,                                  // 连接标志：Clean Session
    (keepalive >> 8) & 0xff, keepalive & 0xff
  ];
  body.push((id.length >> 8) & 0xff, id.length & 0xff);
  for (var i = 0; i < id.length; i++) body.push(id[i]);
  return buildPacket(0x10, body);
}

/* SUBSCRIBE：固定头高 4 位必须为 0x2（QoS1 语义），所以是 0x82 */
function buildSubscribe(packetId, topic, qos) {
  var t = utf8Encode(topic);
  var body = [(packetId >> 8) & 0xff, packetId & 0xff];
  body.push((t.length >> 8) & 0xff, t.length & 0xff);
  for (var i = 0; i < t.length; i++) body.push(t[i]);
  body.push(qos & 0x03);
  return buildPacket(0x82, body);
}

/* PUBACK：收到 QoS1 下行报文时回执，避免服务端重发 */
function buildPuback(packetId) {
  return buildPacket(0x40, [(packetId >> 8) & 0xff, packetId & 0xff]);
}

/* PUBLISH：可变头 = 主题（两字节长度前缀 + UTF-8）+ [QoS>0 时的报文标识符]，
   载荷跟在后面；固定头 = 0x30 | (QoS << 1) | retain。
   QoS0 不发标识符也不等回执，本端的干预广播就用 QoS0 + retain。 */
function buildPublish(topic, payload, qos, packetId, retain) {
  var t = utf8Encode(topic);
  var body = [(t.length >> 8) & 0xff, t.length & 0xff];
  for (var i = 0; i < t.length; i++) body.push(t[i]);

  if (qos > 0) body.push((packetId >> 8) & 0xff, packetId & 0xff);

  var p = utf8Encode(payload);
  for (var j = 0; j < p.length; j++) body.push(p[j]);

  var header = 0x30 | ((qos & 0x03) << 1) | (retain ? 0x01 : 0x00);
  return buildPacket(header, body);
}

var PACKET_PINGREQ = new Uint8Array([0xc0, 0x00]).buffer;
var PACKET_DISCONNECT = new Uint8Array([0xe0, 0x00]).buffer;

/* 从字节流里解析出完整报文。
   WebSocket 分片理论上会把一个 MQTT 报文拆到多帧，所以这里按「字节缓冲区」
   处理：解出完整报文就回调，剩下的残包原样返回给下次拼接。 */
function decodePackets(u8, onPacket) {
  var pos = 0;
  var total = u8.length;

  while (pos < total) {
    if (total - pos < 2) break;

    // —— 解析剩余长度（变长整数，最多 4 字节）——
    var multiplier = 1, value = 0, p = pos + 1, byte, overflow = false;
    do {
      if (p >= total) { overflow = true; break; }   // 长度字段还没收全
      byte = u8[p++];
      value += (byte & 0x7f) * multiplier;
      multiplier *= 128;
      if (multiplier > 128 * 128 * 128) { overflow = true; break; }
    } while ((byte & 0x80) !== 0);

    if (overflow) break;
    if (total - p < value) break;                   // 载荷还没收全

    var packetEnd = p + value;
    onPacket(u8[pos], u8, p, packetEnd);
    pos = packetEnd;
  }

  return u8.slice(pos);   // 未消费的残包
}

/* ============================================================
   ③ 业务纯函数
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

/* 从主题里取区域段：Airguard-x9k2m/zone-n/data → zone-n */
function zoneFromTopic(topic) {
  var seg = String(topic || '').split('/');
  for (var i = 0; i < seg.length; i++) {
    var id = deriveZoneId(seg[i]);
    if (id) return id;
  }
  return null;
}

/* 双通道区域校验：主题段与报文 zoneId 必须指向同一区域，防止数据串区。
   任一路写了无法识别的区域、或两路互相矛盾，整条报文一律拒收；
   主题认不出区域时绝不回退到报文 zoneId —— 那正是串区报文的典型形态
   （主题 Airguard-x9k2m/zone-m/data + 报文 zoneId=zone-w）。
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

/* 环境结论判定 —— 任务书规则，一律本地重算，不信任报文里的 status：
     pm25 > 150            → 重度污染
     pm25 > 75             → 轻度污染
     pm25 ≤ 75 且 co2 ≥ 1500 → 通风不足风险
     其余                   → 正常                                     */
function evaluateLevel(pm25, co2) {
  if (typeof pm25 === 'number' && pm25 > 150) return 'critical';
  if (typeof pm25 === 'number' && pm25 > 75) return 'warning';
  if (typeof pm25 === 'number' && pm25 <= 75 && typeof co2 === 'number' && co2 >= 1500) return 'serious';
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

/* 更新时间只显示「时:分:秒」，完整值放到 timeFull 里 */
function formatTime(raw) {
  if (raw === undefined || raw === null || raw === '') return '—';
  var s = String(raw).trim();
  var m = s.match(/(\d{1,2}:\d{2}(?::\d{2})?)\s*$/);
  return m ? m[1] : s;
}

/* 解析一条报文 → 该区域的结论对象；校验失败返回 { error } */
function parseReading(topic, rawText) {
  var payload;
  try {
    payload = JSON.parse(rawText);
  } catch (e) {
    return { error: 'json', detail: '报文不是合法 JSON' };
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return { error: 'shape', detail: '报文不是对象' };
  }

  var resolved = resolveZone(topic, payload);
  if (resolved.error) return resolved;

  var pm25 = toNum(field(payload, ['pm25', 'pm2.5', 'pm2_5']));
  var co2 = toNum(field(payload, ['co2', 'co_2', 'co2ppm']));
  var crowdLevel = toNum(field(payload, ['crowdlevel', 'crowd_level', 'crowd']));
  var reportedStatus = field(payload, ['status']);
  var time = field(payload, ['time', 'timestamp', 'ts']);

  var level = evaluateLevel(pm25, co2);

  var crowdText;
  if (crowdLevel === null) {
    crowdText = '—';
  } else if (Object.prototype.hasOwnProperty.call(CROWD_LEVELS, crowdLevel)) {
    crowdText = CROWD_LEVELS[crowdLevel];
  } else {
    crowdText = '未知（' + crowdLevel + '）';   // 超出 0–3 的取值如实暴露，不静默吞掉
  }

  return {
    reading: {
      zoneId: resolved.zoneId,
      pm25: pm25,
      co2: co2,
      crowdLevel: crowdLevel,
      crowdText: crowdText,
      level: level,
      reportedStatus: reportedStatus,
      time: time,
      // 解析成毫秒：持续时长要按报文时间戳做减法，字符串没法比
      ts: (toDate(time) || new Date()).getTime(),
      // 归一化到 YYYY-MM-DD HH:MM:SS：事件时间、去重指纹、日志都按它对齐
      timeFull: fmtStampFull(time) || fmtStampFull(Date.now()),
      /* 低可信度感知数据不能促成恢复 —— 解析时就算好，状态机直接用 */
      lowConfidence: isLowConfidence(payload)
    },
    /* 原始报文一并交出去：D3 去重要按 message_id 认报文，那是解析不出来、
       也没法从 reading 反推的字段 */
    payload: payload,
    mismatch: (reportedStatus !== undefined && String(reportedStatus).trim() !== LEVELS[level].label)
      ? '上报 status="' + reportedStatus + '"，本地按规则重算为 "' + LEVELS[level].label + '"，以本地结论为准'
      : null
  };
}

/* ============================================================
   ③-b 会话内记录的数据结构（纯函数，不依赖小程序 API）
   ------------------------------------------------------------
   记录只存「收到过什么」，字段与 web 监测台导出的 CSV 表头一致：
       time, zone, pm25, co2, crowdLevel, status
   本端不提供 CSV 导出（导出只在 web 监测台）；四端一律不落盘，
   记录只留在内存里，重进小程序即全部清零。
   ============================================================ */

var RECORD_LIMIT = 5000;   // 内存里最多保留 5000 条，超出丢最旧的

/* 全部历史记录；模块级单例，清空时就地改写而不是换新数组 */
var historyRecords = [];

/* 任意时间写法 → Date；解析不出来返回 null。
   与 web 监测台的 parseStamp 同一口径——四端必须对同一个时间写法得到同一个
   时刻，否则「乱序」判定在四端会得出不同结论。 */
function toDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    var d0 = new Date(value < 1e12 ? value * 1000 : value);   // 秒级 / 毫秒级都收
    return isNaN(d0.getTime()) ? null : d0;
  }
  var raw = String(value).trim();
  if (raw === '') return null;

  /* 采集端把时间戳 stringify 成字符串（"1791091745" / "1791091745000"）：
     与数字同等对待，不认这种写法乱序判定会悄悄退回「谁后到谁更新」 */
  if (/^\d{10}$|^\d{13}$/.test(raw)) {
    var n = Number(raw);
    var d1 = new Date(n < 1e12 ? n * 1000 : n);
    return isNaN(d1.getTime()) ? null : d1;
  }

  /* 带日期的时间：手写解析，不依赖各内核 Date 解析的宽松程度——
     "2026-10-4 13:28:00"（不补零）在部分内核上解析不出来，
     直接落回「接收时刻」，乱序判定同样会失效 */
  var fm = /^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(raw);
  if (fm) {
    var d2 = new Date(Number(fm[1]), Number(fm[2]) - 1, Number(fm[3]),
                      Number(fm[4]), Number(fm[5]), Number(fm[6] || 0));
    return isNaN(d2.getTime()) ? null : d2;
  }

  // 只给了时分秒（如 "16:10:01"）：按今天补日期，否则恢复出来的时间点会跨天漂移
  var t = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (t) {
    var d3 = new Date();
    d3.setHours(Number(t[1]), Number(t[2]), Number(t[3] || 0), 0);
    return d3;
  }

  var ts = Date.parse(raw);
  if (isNaN(ts)) ts = Date.parse(raw.replace(/-/g, '/'));   // 兼容部分内核的解析差异
  return isNaN(ts) ? null : new Date(ts);
}

function pad2(n) { return n < 10 ? '0' + n : String(n); }

/* 四位补零：感知记录编号用（cam-zone-n-0001）。
   超过四位不截断，宁可多一位也不要两条记录撞号 */
function pad4(n) {
  return n < 10 ? '000' + n : (n < 100 ? '00' + n : (n < 1000 ? '0' + n : String(n)));
}

/* 时间戳归一化为 YYYY-MM-DD HH:MM:SS，落盘用；失败返回空串 */
function fmtStampFull(value) {
  var d = toDate(value);
  if (!d) return '';
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
         pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
}

/* 结论对象 → 记录条目
   按报文原值存档，不做取整也不裁剪：记录是「收到过什么」的存档，
   与页面上经过归一化的展示值分开算。status 存上报值，不存本地重算结果。 */
function toRecord(reading) {
  return {
    // 报文没带时间就用本地接收时刻补上，否则恢复时整条记录没有落点
    time: fmtStampFull(reading.time) || fmtStampFull(Date.now()),
    zone: reading.zoneId,
    pm25: reading.pm25,
    co2: reading.co2,
    crowdLevel: reading.crowdLevel,
    status: (reading.reportedStatus === undefined || reading.reportedStatus === null)
      ? '' : String(reading.reportedStatus)
  };
}

/* 超出上限时丢最旧的 */
function trimRecords(arr) {
  var over = arr.length - RECORD_LIMIT;
  if (over > 0) arr.splice(0, over);
  return arr;
}

/* ============================================================
   ③-c 持续风险与优先关注（纯函数，作用在传入的共享状态上）
   ============================================================ */

/* 感知记录：每条通过校验的报文派生一条，字段与另外四端一致。
   source 与 confidence 在本系统里没有真实来源，写死而不是留空，
   是为了让「这条记录是怎么来的」在界面上一眼可见。 */
function addPerception(g, reading) {
  var n = (perceptionSeq[reading.zoneId] || 0) + 1;
  perceptionSeq[reading.zoneId] = n;
  g.perception.unshift({
    zoneId: reading.zoneId,
    // 真实系统里这里是抓拍图编号；本地没有图片，用「相机 + 区域 + 该区域第几条」
    // 拼出来，既能唯一标识，也比随机数好核对
    imageId: 'cam-' + reading.zoneId + '-' + pad4(n),
    crowdLevel: CROWD_LEVELS[crowdScore(reading.crowdLevel)],
    confidence: null,
    source: PRIORITY_SOURCE,
    // 完整到日期：感知记录是存档性质的，只写 HH:MM:SS 跨天就没法核对了
    time: fmtStampFull(reading.time) || fmtStampFull(Date.now())
  });
  if (g.perception.length > PERCEPTION_LIMIT) {
    g.perception.length = PERCEPTION_LIMIT;
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

/* 打分写入 g.priority。就地改属性而不是换对象：页面订阅回调可能持有旧引用 */
function computePriority(g) {
  var rows = [];

  for (var i = 0; i < ZONES.length; i++) {
    var zid = ZONES[i].id;
    var d = g.zones[zid];
    if (!d) continue;

    var streak = g.streaks[zid] || 0;
    var env = streak === 0 ? 0
            : (streak === 1 ? PRIORITY_ENV_SINGLE : PRIORITY_ENV_STREAK);
    var crowd = crowdScore(d.crowdLevel);
    /* 持续时间只看本轮连续异常：末条记录时刻 − 首条记录时刻。
       streak 为 0 或 1 时首末同一条，时长 0 */
    var started = g.streakStart[zid];
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
  g.priority.rows = rows;
  g.priority.winner = top;
}

/* ============================================================
   ③-d D3 干预—验证—恢复（判定函数与消息去重，纯函数）
   ------------------------------------------------------------
   这是四端共用的规则层：状态机（在 App 实例里）只调用这里的判定，
   不自己另算一套。「哪端算得对」这种事一旦说不清，四端就没法收敛了。
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
  var crowd = crowdScore(reading.crowdLevel);
  return 'PM2.5 ' + reading.pm25 + ' μg/m³ / CO₂ ' + reading.co2 + ' ppm（' +
         LEVELS[reading.level].label + '）+ 人流' +
         CROWD_LEVELS[crowd] + ' ' + reading.crowdLevel +
         ' 级 → 严重度 ' + severityOf(LEVELS[reading.level].rank, crowd);
}

/* 这条读数该配哪一组干预动作（异常类型决定组别） */
function eventActionKey(reading) {
  var rank = LEVELS[reading.level].rank;
  var crowd = crowdScore(reading.crowdLevel);
  if (eventTypeOf(rank, crowd) === '人流拥挤') {
    // 判成人流拥挤时 crowd 必然 ≥ 2（更小的话环境分就压过它了），夹一下只是防御
    return 'crowd' + (crowd < 2 ? 2 : crowd);
  }
  return reading.level;
}

/* 消息去重键。优先报文自带的 message_id；没有才用区域 + 时间 + 载荷指纹。
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

/* 记一条去重键；返回 true 表示这条报文之前已经来过，本次不再生效 */
function isDuplicate(key) {
  if (Object.prototype.hasOwnProperty.call(seenSet, key)) return true;
  seenSet[key] = 1;
  seenKeys.push(key);
  if (seenKeys.length > EV_DEDUPE_MAX) delete seenSet[seenKeys.shift()];
  return false;
}

/* 区域中文名：事件卡片上要显示「宿舍区」，而不是 zone-n 这种代号 */
function findZoneName(zoneId) {
  for (var i = 0; i < ZONES.length; i++) {
    if (ZONES[i].id === zoneId) return ZONES[i].name;
  }
  return '';
}

/* ============================================================
   ④ MQTT 客户端（基于 wx.connectSocket）
   ============================================================ */

function noop() {}

function createMqttClient(config, handlers) {
  var socket = null;
  var rx = new Uint8Array(0);
  var packetId = 0;
  var pingTimer = null;
  var reconnectTimer = null;
  var closedByUser = false;
  var connected = false;
  var probeTimer = null;        // 单个候选地址的探测超时
  var urlIndex = 0;             // 当前在试第几个候选地址

  function nextPacketId() {
    packetId = (packetId % 65535) + 1;
    return packetId;
  }

  function send(buffer) {
    if (!socket || !connected) return;
    socket.send({ data: buffer });
  }

  function clearTimers() {
    if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    clearProbeTimer();
  }

  /* ---------- 候选 Broker 地址探测 ----------
     逐个试候选地址，拿到 CONNACK 的那个就算命中；都不通过就整串循环重试。
     现在候选里只有公网 Broker 一条，探测默认不启用（多于 1 条地址才会切）。 */
  function candidateList() {
    return (config.candidates && config.candidates.length) ? config.candidates : [config.url];
  }

  /* 换下一个候选地址；返回 true 表示确实换了（只有一个地址时不换） */
  function switchCandidate() {
    var list = candidateList();
    if (list.length < 2) return false;
    urlIndex = (urlIndex + 1) % list.length;
    config.url = list[urlIndex];
    return true;
  }

  function clearProbeTimer() {
    if (probeTimer) { clearTimeout(probeTimer); probeTimer = null; }
  }

  /* 到点还没收到 CONNACK，就认定这个地址连不上，立刻换下一个 */
  function armProbeTimer() {
    clearProbeTimer();
    if (!config.probeTimeout || candidateList().length < 2) return;
    probeTimer = setTimeout(function () {
      probeTimer = null;
      if (connected || closedByUser || !socket) return;
      var wrapped = (urlIndex + 1 >= candidateList().length);
      handlers.onState('error', wrapped
        ? '候选地址都连不上：确认手机能上网（公网 Broker），稍后自动重试…'
        : '连不上 ' + config.url + '，换下一个地址…');
      try { socket.close(); } catch (e) {}
      socket = null;
      if (switchCandidate()) scheduleReconnect(600);   // 换地址要快，不等满重连周期
      else scheduleReconnect();
    }, config.probeTimeout);
  }

  function handlePacket(header, buf, bodyStart, packetEnd) {
    var type = header >> 4;

    if (type === 2) {
      /* CONNACK */
      var code = buf[bodyStart + 1];
      if (code === 0) {
        connected = true;
        clearProbeTimer();          // 已拿到 CONNACK，这个地址就是可用的，停止探测
        handlers.onState('connected');
        /* 两个主题各发一个 SUBSCRIBE：报文流 + 干预广播。
           别端的干预要让本端同时进入「处理中」，漏订阅就收敛不了 */
        send(buildSubscribe(nextPacketId(), config.topic, config.qos));
        if (config.interventionTopic) {
          send(buildSubscribe(nextPacketId(), config.interventionTopic, config.qos));
        }
        // 保活：按 keepalive 的 3/4 周期发 PINGREQ，防止服务端判定超时断连
        pingTimer = setInterval(function () { send(PACKET_PINGREQ); },
                                Math.max(5, config.keepalive * 0.75) * 1000);
      } else {
        handlers.onState('error', 'Broker 拒绝连接，CONNACK 返回码 ' + code);
        close(true);
      }

    } else if (type === 3) {
      /* PUBLISH */
      var qos = (header >> 1) & 0x03;
      var p = bodyStart;
      var topicLen = (buf[p] << 8) | buf[p + 1]; p += 2;
      var topic = utf8Decode(buf, p, p + topicLen); p += topicLen;
      var pid = 0;
      if (qos > 0) {
        pid = (buf[p] << 8) | buf[p + 1]; p += 2;
      }
      var text = utf8Decode(buf, p, packetEnd);
      if (qos === 1) send(buildPuback(pid));
      handlers.onMessage(topic, text);

    } else if (type === 9) {
      /* SUBACK：返回码 0x80 表示订阅被拒绝 */
      var granted = buf[bodyStart + 2];
      if (granted === 0x80) {
        handlers.onState('error', '订阅 ' + config.topic + ' 被 Broker 拒绝');
      }

    } else if (type === 13) {
      /* PINGRESP：链路存活，无需处理 */
    }
  }

  function onBytes(arrayBuffer) {
    var chunk = new Uint8Array(arrayBuffer);
    var merged = new Uint8Array(rx.length + chunk.length);
    merged.set(rx, 0);
    merged.set(chunk, rx.length);
    rx = decodePackets(merged, handlePacket);
  }

  function scheduleReconnect(delay) {
    if (closedByUser || reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, typeof delay === 'number' ? delay : config.reconnectPeriod);
  }

  function sendDisconnect() {
    if (connected && socket) {
      try { socket.send({ data: PACKET_DISCONNECT }); } catch (e) {}
    }
  }

  function close(silent) {
    clearTimers();
    sendDisconnect();
    connected = false;
    if (socket) {
      try { socket.close({ code: 1000 }); } catch (e) {}
      socket = null;
    }
    rx = new Uint8Array(0);
    if (!silent) handlers.onState('closed');
  }

  function connect() {
    if (socket) return;
    rx = new Uint8Array(0);
    handlers.onState('connecting');

    var s;
    try {
      s = wx.connectSocket({
        url: config.url,
        protocols: [config.protocol],   // 不带这个子协议，EMQX 会直接拒绝握手
        timeout: 8000
      });
    } catch (e) {
      handlers.onState('error', '创建 WebSocket 失败：' + (e && e.message ? e.message : e));
      socket = null;
      scheduleReconnect();
      return;
    }
    socket = s;

    /* 探测超时换地址时，旧 socket 会被关掉重开，但它的回调还会补发一次。
       每个回调先确认「我还代表当前这条连接」，避免旧连接的回调误伤新连接 */
    function isCurrent() { return s === socket; }

    s.onOpen(function () {
      if (!isCurrent()) return;
      connected = false;   // 等 CONNACK 才算真正连上
      s.send({ data: buildConnect(clientId(), config.keepalive) });
    });

    s.onMessage(function (res) {
      if (!isCurrent()) return;
      if (res.data instanceof ArrayBuffer) {
        onBytes(res.data);
      } else if (res.data && res.data.buffer) {
        onBytes(res.data.buffer);
      }
    });

    s.onError(function (err) {
      if (!isCurrent()) return;
      var wasConnected = connected;   // 这条连接此前是否已经握手成功过
      handlers.onState('error', 'WebSocket 错误：' + (err && err.errMsg ? err.errMsg : err));
      connected = false;
      try { s.close(); } catch (e) {}
      socket = null;
      /* 连上过再掉线 → 地址是对的，重连同一个；压根没连上 → 换下一个候选地址 */
      if (!closedByUser && !wasConnected && switchCandidate()) { scheduleReconnect(600); return; }
      scheduleReconnect();
    });

    s.onClose(function () {
      if (!isCurrent()) return;
      clearTimers();
      var wasConnected = connected;
      connected = false;
      socket = null;
      if (closedByUser) return;
      handlers.onState('closed');
      if (!wasConnected && switchCandidate()) { scheduleReconnect(600); return; }
      scheduleReconnect();
    });

    armProbeTimer();
  }

  function clientId() {
    return 'airguard-mp-' + Math.random().toString(16).slice(2, 10);
  }

  return {
    /* 启动（含手动重连）时，从第一个候选地址重新扫一遍 */
    start: function () {
      closedByUser = false;
      urlIndex = 0;
      config.url = candidateList()[0];
      connect();
    },
    stop: function () { closedByUser = true; close(true); handlers.onState('closed'); },
    isConnected: function () { return connected; },
    /* 小程序切后台可能被系统断开，回到前台时补一次连接 */
    ensure: function () { if (!socket) { closedByUser = false; connect(); } },

    /* 上行 PUBLISH：D3 的干预广播走这里。
       retain=true 让后接入的端（比如刚刷新的大屏）一连上就拿到当前状态。
       未连接时返回 false 而不是静默丢弃 —— 调用方要能据此提示「只在本地生效」 */
    publish: function (topic, payload, qos, retain) {
      if (!connected) return false;
      send(buildPublish(topic, payload, qos || 0, nextPacketId(), !!retain));
      return true;
    }
  };
}

/* ============================================================
   ⑤ 小程序应用实例
   （Node 侧协议验证会剔除下面这段，只取上面的纯函数）
   ============================================================ */

App({
  /* 常量与纯函数挂到实例上，页面通过 getApp() 直接取用 */
  ZONES: ZONES,
  LEVELS: LEVELS,
  CROWD_LEVELS: CROWD_LEVELS,
  MQTT_CONFIG: MQTT_CONFIG,
  formatTime: formatTime,

  globalData: {
    conn: 'connecting',
    connText: '连接中',
    connDetail: '正在连接 ' + MQTT_CONFIG.url + ' …',
    zones: {},                                   // zoneId → 最新结论
    counters: { messages: 0, rejected: 0, duplicates: 0 },
    streaks: {},                                 // zoneId → 末尾连续异常条数
    perception: [],                              // 感知记录，最新在前，上限 PERCEPTION_LIMIT
    streakStart: {},                             // zoneId → 本轮连续异常首条记录的时刻（ms）
    priority: { rows: [], winner: null },        // 优先关注打分结果
    /* D3：事件表（最新在后）与当前事件索引。只活在内存里，重进小程序回到初始态 */
    events: [],
    activeEvents: {}                             // zoneId → 该区域当前事件
  },

  listeners: [],
  client: null,

  onLaunch: function () {
    var that = this;

    /* 不做任何恢复：卡片、事件表、D3 状态机全部只活在内存里，
       重进小程序即回到「等第一条报文」，由本次会话新收到的数据重新建立
       （跨端一致性靠 MQTT 干预广播收敛） */

    this.client = createMqttClient(MQTT_CONFIG, {
      onState: function (state, detail) { that.setState(state, detail); },
      onMessage: function (topic, text) {
        /* 干预广播与报文流共用一条连接，靠主题前缀分流 */
        if (String(topic).indexOf(MQTT_CONFIG.interventionPrefix) === 0) {
          that.onIntervention(text);
          return;
        }
        that.ingest(topic, text);
      }
    });

    this.client.start();
  },

  onShow: function () {
    // 小程序从后台回到前台：若连接已被系统回收则重连
    if (this.client) this.client.ensure();
  },

  /* 订阅状态变更；返回取消订阅函数 */
  subscribe: function (fn) {
    this.listeners.push(fn);
    var list = this.listeners;
    return function () {
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  },

  notify: function () {
    for (var i = 0; i < this.listeners.length; i++) {
      try { this.listeners[i](); } catch (e) { console.error('[AirGuard] 渲染回调异常', e); }
    }
  },

  setState: function (state, detail) {
    var g = this.globalData;
    if (state === 'connecting') {
      g.conn = 'connecting'; g.connText = '连接中';
      g.connDetail = detail || ('正在连接 ' + MQTT_CONFIG.url + ' …');
    } else if (state === 'connected') {
      g.conn = 'connected'; g.connText = 'MQTT 已连接';
      g.connDetail = '已连接 ' + MQTT_CONFIG.url + ' · 已订阅 ' + MQTT_CONFIG.topic + ' · 等待报文…';
    } else if (state === 'closed') {
      g.conn = 'error'; g.connText = '连接已断开';
      g.connDetail = '与 Broker 的连接已断开，将每 ' + (MQTT_CONFIG.reconnectPeriod / 1000) + ' 秒自动重连…';
    } else {
      g.conn = 'error'; g.connText = '连接异常';
      g.connDetail = detail || '未知错误';
    }
    this.notify();
  },

  /* 处理一条 MQTT 报文
     opts.cached = true 表示这是启动时从本地存储回灌的历史读数，不是刚收到的报文 */
  ingest: function (topic, text, opts) {
    var g = this.globalData;
    var result = parseReading(topic, text);

    if (result.error) {
      g.counters.rejected++;
      console.warn('[AirGuard] 报文已丢弃（' + result.error + '）：' + result.detail, '主题 =', topic, '报文 =', text);
      this.notify();
      return;
    }

    if (result.mismatch) {
      console.warn('[AirGuard] ' + result.reading.zoneId + ' ' + result.mismatch);
    }

    var cached = !!(opts && opts.cached);

    /* D3 去重：同一条消息多次到达只生效一次。
       本地存档回灌不算「刚收到的报文」，不进去重表 —— 否则重进小程序时
       回灌的那一条会把去重键占掉，随后真的收到同一条实时报文会被误判为重复 */
    if (!cached) {
      var key = dedupeKey(result.payload, result.reading.zoneId, result.reading);
      if (isDuplicate(key)) {
        g.counters.duplicates++;
        result.reading.duplicate = true;
        console.info('[AirGuard] 重复报文已忽略：' + result.reading.zoneId + ' · ' + key);
        return;
      }
    }

    /* ---- D3 消息健壮性：乱序消息不覆盖更新的实时状态 ----
       报文时间早于本会话已入住的读数，就是「后到达的旧消息」。它照样算收到、
       照样进历史与感知记录，但不回写实时读数、不动连续异常计数、不进趋势图，
       也不能凭一个更早的时间去开新事件 —— 那同样是旧消息覆盖新状态。
       跨会话不比较：存档读数标着 cached，设备时钟被重置过时仍以实时报文为准。 */
    var prevReading = g.zones[result.reading.zoneId];
    if (!cached && prevReading && !prevReading.cached && result.reading.ts < prevReading.ts) {
      result.reading.outOfOrder = true;
      addPerception(g, result.reading);
      historyRecords.push(toRecord(result.reading));
      trimRecords(historyRecords);
      /* 只往已有事件的日志里补一笔；没有事件就不建 —— 旧消息不产生新状态 */
      if (g.activeEvents[result.reading.zoneId]) this.applyEvent(result.reading);
      g.clearNote = null;
      g.counters.messages++;
      this.notify();
      return;
    }

    result.reading.cached = cached;      // 一旦来了实时报文就自动脱掉缓存标记
    g.zones[result.reading.zoneId] = result.reading;

    /* 连续异常计数：正常即归零。重进小程序后从头算起——
       存档回灌只有每区域最后一条记录，「连续了几次」无从得知，按单次计。
       这是本模块已知的口径损耗：连续分只在本次会话里累积。 */
    var zoneId = result.reading.zoneId;
    if (result.reading.level === 'good') {
      g.streaks[zoneId] = 0;
      g.streakStart[zoneId] = null;
    } else if (cached) {
      /* 回放只知道「末尾这条是异常」，连续了几次、从哪一刻起都无从得知，
         按单次计，起点也只能记成这条自己 —— 时长自然是 0 */
      g.streaks[zoneId] = 1;
      g.streakStart[zoneId] = result.reading.ts;
    } else {
      // 0 → 1 是本轮连续异常的起点，只有这一跳才写 streakStart
      if (!g.streaks[zoneId]) g.streakStart[zoneId] = result.reading.ts;
      g.streaks[zoneId] = (g.streaks[zoneId] || 0) + 1;
    }

    /* 缓存回灌走同一条入库路径（卡片的渲染逻辑只有一份），
       但它不是「刚收到的报文」：不计消息数、不进历史、不产生感知记录。
       否则每次重进小程序都会凭空多出一批消息。 */
    if (cached) {
      computePriority(g);
      this.notify();
      return;
    }

    addPerception(g, result.reading);
    computePriority(g);
    historyRecords.push(toRecord(result.reading));
    trimRecords(historyRecords);

    /* D3：每条通过去重的实时报文推进一次事件状态机。
       上面 cached 分支已经 return 了 —— 缓存回灌不推进 */
    this.applyEvent(result.reading);

    g.clearNote = null;      // 收到实时报文，清空回执让位给正常状态
    g.counters.messages++;
    this.notify();
  },

  /* ---------- D3 干预—验证—恢复：事件状态机 -------------------------------
   * 判定规则在 ③-d 节，这里只负责推进，状态只活在内存里。
   * 唯一入口是 applyEvent：不管报文从哪来，状态每一次变化都要经过它，
   * 别的函数不许直接写 ev.state。
   * ---------------------------------------------------------------------- */

  /* 事件日志：每条影响过判断的报文留一行，便于事后对账 */
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
    var ev = {
      event_id: 'evt-' + reading.zoneId + '-' + (++eventSeq) + '-' + reading.ts,
      zoneId: reading.zoneId,
      zoneName: findZoneName(reading.zoneId) || reading.zoneId,
      startedAt: reading.timeFull,             // 事件开始时间
      startedTs: reading.ts,
      type: eventTypeOf(rank, crowd),          // 异常类型
      priorityReason: eventReason(reading),    // 优先关注理由
      userActions: [],                         // 用户干预动作记录
      verifySamples: [],                       // 干预后多组验证数据集
      state: EV_OPEN,                          // 当前事件状态
      interventionAt: null,                    // 干预提交时刻
      severityAtIntervention: null,
      recoveredAt: null,                       // 恢复时间
      outcome: '待处理',                        // 最终结果
      manualReview: false,                     // 低可信度数据触发的「人工复核」标记
      severity: severityOf(rank, crowd),
      actionKey: eventActionKey(reading),
      lastTs: reading.ts,                      // 已处理到的最新报文时刻，用于识别乱序 / 迟到
      relapseSamples: 0,
      log: []
    };

    var g = this.globalData;
    this.pushLog(ev, reading, '监测捕获异常，事件建立');
    /* 最新在前：存档按顺序取前 N 条就是最新的 N 条，恢复时每个区域
       第一条遇到的也正好是它的当前事件 */
    g.events.unshift(ev);
    if (g.events.length > EVENTS.limit) g.events.length = EVENTS.limit;
    g.activeEvents[ev.zoneId] = ev;
    console.info('[AirGuard] 事件建立：' + ev.event_id + ' · ' + ev.type + ' · 严重度 ' + ev.severity);
    return ev;
  },

  /** 事件机唯一入口。每条通过去重的实时报文进来一次。
   *  乱序 / 迟到（时间戳早于本事件已处理的最后一条）不参与状态判断，只入日志 */
  applyEvent: function (reading) {
    var rank = LEVELS[reading.level].rank;
    var crowd = crowdScore(reading.crowdLevel);
    var g = this.globalData;
    var ev = g.activeEvents[reading.zoneId] || null;

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
      console.info('[AirGuard] 事件已恢复：' + ev.event_id + ' · ' + ev.recoveredAt);
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
        console.info('[AirGuard] 干预无效，事件回退待处理：' + ev.event_id);
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
    var g = this.globalData;
    var ev = g.activeEvents[zoneId];
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
      actor: meta.actor || '小程序'
    });
    ev.interventionAt = ev.userActions[ev.userActions.length - 1].at;
    ev.severityAtIntervention = ev.severity;
    ev.verifySamples.length = 0;
    ev.relapseSamples = 0;
    ev.manualReview = false;
    ev.outcome = '干预已提交，等待新监测数据验证';
    this.pushLog(ev, { timeFull: ev.interventionAt, ts: Date.now() },
      '管理员提交干预：' + list.join(' / '));
    this.notify();
    return ev;
  },

  /* 页面点【执行干预】：本端状态机 + 向另外三端广播。
     广播失败不算提交失败 —— 本端状态已经推进，只是别端收不到 */
  submitIntervention: function (zoneId, actions) {
    var ev = this.intervene(zoneId, actions, { actor: '小程序' });
    if (ev) {
      this.publishIntervention(ev, ev.userActions[ev.userActions.length - 1].actions);
    }
    return ev;
  },

  /** 收到别端广播来的干预（Web 大屏 / 3D 沙盘 / 移动端浏览器版）。
   *  event_id 对得上、且本端该区域事件正处于 OPEN 才应用；其余一律忽略。
   *  同一条干预重复到达是幂等的（第二次事件已经不是 OPEN，直接被挡） */
  receiveIntervention: function (msg) {
    if (!msg || msg.type !== 'intervention') return null;
    var ev = this.globalData.activeEvents[msg.zoneId];
    if (!ev || ev.state !== EV_OPEN) return null;
    if (msg.event_id && msg.event_id !== ev.event_id) return null;
    console.info('[AirGuard] 收到 ' + (msg.actor || '他端') + ' 的干预广播：' + msg.zoneId);
    return this.intervene(msg.zoneId, msg.actions, { actor: msg.actor, at: msg.at });
  },

  /* MQTT 回调：干预广播的文本载荷 → 状态机 */
  onIntervention: function (text) {
    var msg;
    try {
      msg = JSON.parse(text);
    } catch (e) {
      console.warn('[AirGuard] 干预广播不是合法 JSON，已忽略：', text);
      return;
    }
    this.receiveIntervention(msg);
  },

  /* 把本端的干预动作广播出去，让另外三端同时进入「处理中」。
     固定 retain=true：后接入的端（比如刚刷新的大屏）一连上就能拿到当前状态 */
  publishIntervention: function (ev, actions) {
    if (!this.client || !this.client.isConnected()) {
      console.warn('[AirGuard] MQTT 未连接，干预只在本地生效，未广播');
      return false;
    }
    var msg = {
      type: 'intervention',
      event_id: ev.event_id,      // 收端据此判断这条广播属于哪个事件
      zoneId: ev.zoneId,
      actions: actions,
      at: ev.interventionAt,
      time: fmtStampFull(Date.now()),
      actor: '小程序'
    };
    var ok = this.client.publish(MQTT_CONFIG.interventionPrefix + ev.zoneId,
      JSON.stringify(msg), MQTT_CONFIG.qos, true);
    if (ok) console.info('[AirGuard] 已广播干预：' + ev.zoneId + ' → ' + actions.join(' / '));
    return ok;
  },

  /* ---------- 会话内记录（只存内存） -------------------------------------- */

  /* 供页面与自动化测试取用 */
  recordLimit: RECORD_LIMIT,
  historyRecords: historyRecords,
  historyCount: function () { return historyRecords.length; },

  /* 持续风险与优先关注：规则常量（打分结果与感知记录在 globalData 里，
     内存态、不落盘，重进小程序即重来）。页面与联调都读 globalData.priority。 */
  priority: {
    source: PRIORITY_SOURCE,
    envSingle: PRIORITY_ENV_SINGLE,
    envStreak: PRIORITY_ENV_STREAK,
    limit: PERCEPTION_LIMIT,
    spanText: spanText
  },

  /* D3 干预—验证—恢复：常量与只读入口（事件表在 globalData.events /
     activeEvents，页面与联调都从这里读） */
  EVENTS: EVENTS,
  EV_OPEN: EV_OPEN,
  EV_HANDLING: EV_HANDLING,
  EV_RECOVERED: EV_RECOVERED,
  EV_ACTIONS: EV_ACTIONS,
  EV_LABEL: EV_LABEL,
  recoverSamples: 1,
  activeEvent: function (zoneId) { return this.globalData.activeEvents[zoneId] || null; },

  /* 清空记录：只清内存，页面回到「等待推送」（四端都不落盘，没有本地存档可删） */
  clearHistory: function () {
    var n = historyRecords.length;

    historyRecords.length = 0;

    // 就地删除而不是 g.zones = {}：页面或订阅回调可能已经持有这个对象，
    // 换新对象会让它们继续看到旧数据
    var g = this.globalData;
    for (var k in g.zones) {
      if (Object.prototype.hasOwnProperty.call(g.zones, k)) delete g.zones[k];
    }
    /* 连续异常与打分结果也一并归零：它们是从卡片读数派生的，
       读数没了还留着上一个区域的连续分，页面上会自相矛盾 */
    for (var s in g.streaks) {
      if (Object.prototype.hasOwnProperty.call(g.streaks, s)) delete g.streaks[s];
    }
    for (var ss in g.streakStart) {
      if (Object.prototype.hasOwnProperty.call(g.streakStart, ss)) delete g.streakStart[ss];
    }
    for (var p in perceptionSeq) {
      if (Object.prototype.hasOwnProperty.call(perceptionSeq, p)) delete perceptionSeq[p];
    }
    g.perception.length = 0;                 // 就地清空：页面订阅方持有同一引用
    g.priority.rows = [];
    g.priority.winner = null;
    g.counters.messages = 0;
    g.counters.rejected = 0;
    g.clearNote = '记录已清空';
    this.notify();

    console.info('[AirGuard] 已清空 ' + n + ' 条记录（只清内存，本端不落盘）');
    return n;
  }
});
