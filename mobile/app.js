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

var MQTT_CONFIG = {
  url: 'ws://127.0.0.1:8085',   // 与 Web 大屏共用同一个 Broker
  protocol: 'mqtt',             // WebSocket 子协议；mosquitto 要求必须带上
  topic: 'Airguard/+/data',     // + 为区域通配符
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

/* 双通道区域校验：主题段与报文 zoneId 必须指向同一区域，防止数据串区 */
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
      ts: (toDate(time) || new Date()).getTime()
    },
    mismatch: (reportedStatus !== undefined && String(reportedStatus).trim() !== LEVELS[level].label)
      ? '上报 status="' + reportedStatus + '"，本地按规则重算为 "' + LEVELS[level].label + '"，以本地结论为准'
      : null
  };
}

/* ============================================================
   ③-b 历史记录落盘的数据结构（纯函数，不依赖小程序 API）
   ------------------------------------------------------------
   记录只存「收到过什么」，字段与 web 监测台导出的 CSV 表头一致：
       time, zone, pm25, co2, crowdLevel, status
   本端不提供 CSV 导出（导出只在 web 监测台），落盘是为了退出重进
   之后卡片不至于一张白纸重来，也让「清空本地记录」有确切的清除对象。
   ============================================================ */

var HISTORY = {
  key: 'airguard.history.mobile.v1',   // 与 web / map3d 各自独立，不互相覆盖
  limit: 5000,                         // 最多保留 5000 条，超出丢最旧的
  debounceMs: 400                      // 写入节流，见 app 实例里的 scheduleSave
};

/* 全部历史记录；模块级单例，清空时就地改写而不是换新数组 */
var historyRecords = [];

/* 任意时间写法 → Date；解析不出来返回 null */
function toDate(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') {
    var d0 = new Date(value < 1e12 ? value * 1000 : value);   // 秒级 / 毫秒级都收
    return isNaN(d0.getTime()) ? null : d0;
  }
  var raw = String(value).trim();
  // 只给了时分秒（如 "16:10:01"）：按今天补日期，否则恢复出来的时间点会跨天漂移
  var t = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (t) {
    var d1 = new Date();
    d1.setHours(Number(t[1]), Number(t[2]), Number(t[3] || 0), 0);
    return d1;
  }
  var d = new Date(raw.replace(/\//g, '-').replace(' ', 'T'));
  return isNaN(d.getTime()) ? null : d;
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

/* 落盘时间戳 → 毫秒；读不出来返回 null */
function parseStamp(s) {
  var d = toDate(s);
  return d ? d.getTime() : null;
}

/* 一条记录至少要有时间和区域，否则恢复时定位不到任何卡片 */
function isValidRecord(r) {
  return !!r && typeof r === 'object' &&
         typeof r.time === 'string' && r.time &&
         typeof r.zone === 'string' && r.zone;
}

/* 结论对象 → 落盘记录
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

/* 超出上限时丢最旧的。写入前和推入后都调，内存与存档不会各自漂移。 */
function trimRecords(arr) {
  var over = arr.length - HISTORY.limit;
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
  }

  function handlePacket(header, buf, bodyStart, packetEnd) {
    var type = header >> 4;

    if (type === 2) {
      /* CONNACK */
      var code = buf[bodyStart + 1];
      if (code === 0) {
        connected = true;
        handlers.onState('connected');
        send(buildSubscribe(nextPacketId(), config.topic, config.qos));
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

  function scheduleReconnect() {
    if (closedByUser || reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      connect();
    }, config.reconnectPeriod);
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

    try {
      socket = wx.connectSocket({
        url: config.url,
        protocols: [config.protocol],   // 不带这个子协议，mosquitto 会直接拒绝握手
        timeout: 8000
      });
    } catch (e) {
      handlers.onState('error', '创建 WebSocket 失败：' + (e && e.message ? e.message : e));
      socket = null;
      scheduleReconnect();
      return;
    }

    socket.onOpen(function () {
      connected = false;   // 等 CONNACK 才算真正连上
      socket.send({ data: buildConnect(clientId(), config.keepalive) });
    });

    socket.onMessage(function (res) {
      if (res.data instanceof ArrayBuffer) {
        onBytes(res.data);
      } else if (res.data && res.data.buffer) {
        onBytes(res.data.buffer);
      }
    });

    socket.onError(function (err) {
      handlers.onState('error', 'WebSocket 错误：' + (err && err.errMsg ? err.errMsg : err));
      connected = false;
      if (socket) { try { socket.close(); } catch (e) {} socket = null; }
      scheduleReconnect();
    });

    socket.onClose(function () {
      clearTimers();
      connected = false;
      socket = null;
      if (closedByUser) return;
      handlers.onState('closed');
      scheduleReconnect();
    });
  }

  function clientId() {
    return 'airguard-mp-' + Math.random().toString(16).slice(2, 10);
  }

  return {
    start: function () { closedByUser = false; connect(); },
    stop: function () { closedByUser = true; close(true); handlers.onState('closed'); },
    isConnected: function () { return connected; },
    /* 小程序切后台可能被系统断开，回到前台时补一次连接 */
    ensure: function () { if (!socket) { closedByUser = false; connect(); } }
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
    counters: { messages: 0, rejected: 0 },
    restoreInfo: null,                           // 启动时恢复到的条数 / 缓存区域数 / 最新时间
    streaks: {},                                 // zoneId → 末尾连续异常条数
    perception: [],                              // 感知记录，最新在前，上限 PERCEPTION_LIMIT
    streakStart: {},                             // zoneId → 本轮连续异常首条记录的时刻（ms）
    priority: { rows: [], winner: null }         // 优先关注打分结果
  },

  listeners: [],
  client: null,
  storageOk: false,
  saveTimer: null,

  onLaunch: function () {
    var that = this;

    this.storageOk = this.probeStorage();
    this.restoreHistory();       // 先回灌本地历史，页面 onLoad 时直接就能渲染出卡片

    this.client = createMqttClient(MQTT_CONFIG, {
      onState: function (state, detail) { that.setState(state, detail); },
      onMessage: function (topic, text) { that.ingest(topic, text); }
    });

    this.client.start();
  },

  onShow: function () {
    // 小程序从后台回到前台：若连接已被系统回收则重连
    if (this.client) this.client.ensure();
  },

  /* 退到后台可能随时被系统回收，补一次写入，保证不丢最后几百毫秒内的数据 */
  onHide: function () { this.flushSave(); },

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
    this.scheduleSave();

    g.clearNote = null;      // 收到实时报文，清空回执让位给正常状态
    g.counters.messages++;
    this.notify();
  },

  /* ---------- 本地存储 ---------------------------------------------------- */

  /* 供页面与自动化测试取用 */
  HISTORY: HISTORY,
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

  /* wx.setStorageSync 在存储被禁用 / 空间写满时会抛异常。先探测一次，
     不可用就整体降级为「只存内存」，小程序其余功能照常运行。 */
  probeStorage: function () {
    try {
      wx.setStorageSync('__airguard_probe__', '1');
      wx.removeStorageSync('__airguard_probe__');
      return true;
    } catch (e) {
      console.warn('[AirGuard] 本地存储不可用，历史记录只保留在内存中：', e && e.message);
      return false;
    }
  },

  loadHistory: function () {
    if (!this.storageOk) return [];
    var raw;
    try {
      raw = wx.getStorageSync(HISTORY.key);
    } catch (e) {
      return [];
    }
    if (!raw) return [];

    // wx.getStorageSync 存进去是什么类型就取回什么类型，但存档可能被手工改过，
    // 也可能是旧版本结构，所以两种形态都认，再逐条校验
    var arr = raw;
    if (typeof raw === 'string') {
      try {
        arr = JSON.parse(raw);
      } catch (e2) {
        console.warn('[AirGuard] 本地历史不是合法 JSON，已忽略：', e2 && e2.message);
        return [];
      }
    }
    if (!Array.isArray(arr)) return [];

    var out = [];
    for (var i = 0; i < arr.length; i++) {
      if (isValidRecord(arr[i])) out.push(arr[i]);
    }
    return out.slice(-HISTORY.limit);
  },

  saveHistory: function () {
    if (!this.storageOk) return;
    trimRecords(historyRecords);
    try {
      wx.setStorageSync(HISTORY.key, historyRecords);
      return;
    } catch (e) {
      // 配额写满：丢掉一半最旧的再试一次。存档失败不该影响实时监测，所以不往上抛。
      console.warn('[AirGuard] 本地存储写入失败，丢弃最旧的记录后重试：', e && e.message);
    }
    historyRecords.splice(0, Math.ceil(historyRecords.length / 2));
    try {
      wx.setStorageSync(HISTORY.key, historyRecords);
    } catch (e2) {
      console.error('[AirGuard] 本地存储仍无法写入，本次存档跳过：', e2 && e2.message);
    }
  },

  /* 每条报文都同步写一次存储会卡住渲染（JSON 序列化 + 磁盘写），所以攒一小段
     时间再写；退到后台时由 onHide → flushSave 补一次。 */
  scheduleSave: function () {
    var that = this;
    if (!this.storageOk || this.saveTimer) return;
    this.saveTimer = setTimeout(function () {
      that.saveTimer = null;
      that.saveHistory();
    }, HISTORY.debounceMs);
  },

  flushSave: function () {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    this.saveHistory();
  },

  /* 启动时把本地记录回灌成页面状态：每张卡片取该区域最后一次读数。
     复用 ingest 的 cached 分支，卡片渲染逻辑与实时数据完全一致。 */
  restoreHistory: function () {
    var saved = this.loadHistory();
    if (!saved.length) return 0;

    // 就地改写而不是 historyRecords = saved：清空与写入都依赖同一个数组引用
    historyRecords.length = 0;
    for (var i = 0; i < saved.length; i++) historyRecords.push(saved[i]);

    // 每个区域取「最后一条带有效读数的记录」。全空的记录回灌进去会被
    // ingest 判为无效，反而把「串区拦截」计数刷上去。
    var lastByZone = {};
    var lastTs = 0;
    for (var j = 0; j < saved.length; j++) {
      var rec = saved[j];
      if (toNum(rec.pm25) === null && toNum(rec.co2) === null) continue;
      lastByZone[rec.zone] = rec;
      var ts = parseStamp(rec.time);
      if (ts !== null && ts > lastTs) lastTs = ts;
    }

    var restored = 0;
    for (var k = 0; k < ZONES.length; k++) {
      var zid = ZONES[k].id;
      var r = lastByZone[zid];
      if (!r) continue;
      this.ingest('Airguard/' + zid + '/data', JSON.stringify(r), { cached: true });
      restored++;
    }

    this.globalData.restoreInfo = {
      count: saved.length,
      cachedCount: restored,
      lastStamp: lastTs ? fmtStampFull(lastTs).slice(5) : '未知'   // 去掉年份，页脚放得下
    };
    console.info('[AirGuard] 已从本地存储恢复 ' + saved.length + ' 条历史记录，回灌 ' + restored + ' 个区域');
    return saved.length;
  },

  /* 清空本地记录：内存 + 本地存储一起清，页面回到「等待推送」 */
  clearHistory: function () {
    var n = historyRecords.length;

    historyRecords.length = 0;
    this.globalData.restoreInfo = null;
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }

    if (this.storageOk) {
      try {
        wx.removeStorageSync(HISTORY.key);
      } catch (e) {
        console.warn('[AirGuard] 清除本地存储失败：', e && e.message);
      }
    }

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
    g.clearNote = '本地记录已清空';
    this.notify();

    console.info('[AirGuard] 已清空 ' + n + ' 条本地记录');
    return n;
  }
});
