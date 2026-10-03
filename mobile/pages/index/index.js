/* ============================================================
   AirGuard 移动巡检端 · 巡检主页
   ------------------------------------------------------------
   本页只做一件事：把 app.js 里的「共享实时状态」翻译成页面视图模型。
   MQTT 连接、报文解析、结论重算全部在 app.js 完成，页面不重复实现。
   ============================================================ */

var app = null;          // onLoad 时通过 getApp() 取得
var unsubscribe = null;  // 取消订阅句柄，onUnload 时释放

/* 组装卡片视图模型 */
function buildCard(meta, data, index) {
  var vm = {
    id: meta.id,
    name: meta.name,
    order: index,
    reported: !!data,          // 该区域是否已上报过
    cached: false,             // 这条读数是本次会话收到的，还是从本地存储恢复的
    level: 'idle',
    rank: 99,                  // 排序用：越大越靠前
    icon: '',
    pm25: '—',
    co2: '—',
    statusText: '等待数据',
    crowdText: '等待数据',
    timeText: '—',
    actions: []
  };

  if (data) {
    var lv = app.LEVELS[data.level];
    vm.cached = !!data.cached;
    vm.level = data.level;
    vm.rank = lv.rank;
    vm.icon = lv.icon;
    vm.pm25 = data.pm25 === null ? '—' : String(data.pm25);
    vm.co2 = data.co2 === null ? '—' : String(data.co2);
    vm.statusText = lv.label;
    vm.crowdText = data.crowdText;
    vm.timeText = app.formatTime(data.time);
    vm.actions = lv.actions;
  }

  return vm;
}

/* 组装优先关注横幅视图模型。文案与 Web 大屏 / 浏览器版逐字一致，
   五端并行时对不上就能立刻看出是哪一端算错了。 */
function buildPriority(pri) {
  var vm = {
    shown: false, focus: 'no', tag: '当前优先关注',
    zone: '', hasWinner: false, total: 0, split: '', reason: '', verdict: ''
  };

  if (!pri || !pri.rows || !pri.rows.length) return vm;

  vm.shown = true;

  var win = pri.winner;
  if (!win) {
    vm.tag = '持续风险';
    vm.zone = '暂无优先关注';
    vm.split = '各区域环境正常、人流稀疏，总分均为 0';
    return vm;
  }

  vm.focus = 'yes';
  vm.hasWinner = true;
  vm.zone = win.name;
  vm.total = win.total;
  vm.split = '环境异常分 ' + win.env + ' · 人流分 ' + win.crowd;
  vm.reason = win.reason;
  vm.verdict = win.verdict || '';
  return vm;
}

Page({

  data: {
    // 顶部状态
    conn: 'connecting',
    connText: '连接中',
    connDetail: '',

    // 持续风险与优先关注
    priority: {
      shown: false,       // 还没收到任何读数时整块不出现
      focus: 'no',        // yes = 有胜出区域，边框转为橙色强调
      tag: '当前优先关注',
      zone: '',
      hasWinner: false,
      total: 0,
      split: '',
      reason: ''
    },

    // 全局告警横幅
    bannerShown: false,
    bannerLevel: 'critical',
    alerts: [],

    // 全部正常提示 / 空态提示
    allClearShown: false,
    emptyShown: true,

    // 卡片
    zones: [],

    // 页脚链路自检
    msgCount: 0,
    rejectCount: 0,

    // 本地缓存说明：启动时从本地存储恢复后，在页脚交代数据来源
    restoreNote: '',
    clearNote: ''
  },

  onLoad: function () {
    var that = this;
    app = getApp();

    unsubscribe = app.subscribe(function () { that.sync(); });
    this.sync();   // 初始渲染：三张卡片均为空，等待 MQTT 推送
  },

  onUnload: function () {
    if (unsubscribe) { unsubscribe(); unsubscribe = null; }
  },

  onPullDownRefresh: function () {
    // 下拉不做数据刷新（数据由 MQTT 实时推送），仅补一次连接
    if (app && app.client) app.client.ensure();
    wx.stopPullDownRefresh();
  },

  /* 把共享状态同步到页面 */
  sync: function () {
    if (!app) return;

    var g = app.globalData;
    var zones = [];
    var alerts = [];
    var reportedCount = 0;
    var cachedCount = 0;

    for (var i = 0; i < app.ZONES.length; i++) {
      var meta = app.ZONES[i];
      var data = g.zones[meta.id] || null;
      var vm = buildCard(meta, data, i);
      zones.push(vm);

      if (data) {
        reportedCount++;
        if (data.cached) cachedCount++;
        if (data.level !== 'good') {
          alerts.push({
            zoneId: meta.id,
            level: data.level,
            rank: app.LEVELS[data.level].rank,
            text: meta.name + ' · ' + app.LEVELS[data.level].label
          });
        }
      }
    }

    // 异常区域按严重度倒序，最严重的排最前
    alerts.sort(function (a, b) { return b.rank - a.rank; });

    // 卡片排序：异常优先置顶；严重度相同时保持固定的地理顺序（宿舍→教学→食堂）
    zones.sort(function (a, b) {
      if (b.rank !== a.rank) return b.rank - a.rank;
      return a.order - b.order;
    });

    // 缓存说明：恢复了多少条、还有几个区域是缓存读数、缓存到什么时候
    var note = '';
    if (g.restoreInfo && cachedCount > 0) {
      note = '已恢复 ' + g.restoreInfo.count + ' 条本地历史 · ' +
             cachedCount + ' 个区域为缓存读数（' + g.restoreInfo.lastStamp + '）';
    } else if (g.clearNote) {
      note = g.clearNote;
    }

    this.setData({
      conn: g.conn,
      connText: g.connText,
      connDetail: g.connDetail,
      priority: buildPriority(g.priority),
      bannerShown: alerts.length > 0,
      bannerLevel: alerts.length ? alerts[0].level : 'critical',
      alerts: alerts,
      allClearShown: reportedCount > 0 && alerts.length === 0,
      emptyShown: reportedCount === 0,
      zones: zones,
      msgCount: g.counters.messages,
      rejectCount: g.counters.rejected,
      restoreNote: note
    });
  },

  /* 清空本地记录：先问一次，再清存储与内存，页面回到等待推送 */
  onClearHistory: function () {
    if (!app) return;
    var that = this;

    wx.showModal({
      title: '清空本地记录',
      content: '将删除已保存的 ' + app.historyCount() + ' 条记录，并清空页面上的巡检卡片。此操作不可撤销。',
      confirmText: '清空',
      confirmColor: '#d03b3b',
      success: function (res) {
        if (!res.confirm) return;
        app.clearHistory();
        that.sync();
        wx.showToast({ title: '已清空本地记录', icon: 'none' });
      }
    });
  }
});
