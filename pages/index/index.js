/**
 * index.js —— 页面逻辑
 *
 * 1. 页面不直接生成数据，全部通过 utils/request.js 拿；
 * 2. WXML 里不能写表达式函数，所有展示用的衍生数据（过滤列表、统计数字）
 *    都在这里算好再 setData；
 * 3. 交互：提交码、tab 过滤、复制到剪贴板、弹窗、折叠面板、下拉刷新、转发。
 */

const api = require('../../utils/request');

Page({
  data: {
    // ---- 顶部数据 ----
    stats: {
      todayCount: 0,
      availableCount: 0, // 从池子里实时算出来
      totalText: '84.5万',
    },
    noticeText: '平台已处理 1450+ 条反馈，恶意提交、广告及无效组队码将被限制使用',
    accountStatus: '正常',

    // ---- 发码表单 ----
    inputCode: '',
    focusInput: false, // 空态页"去发一个码"按钮用来聚焦输入框

    // ---- 折叠面板 ----
    tutorialOpen: false,
    recordsOpen: false,

    // ---- 我的记录 ----
    myTab: 'submitted', // submitted | copied
    mySubmitted: [],
    myCopied: [],

    // ---- 互助池列表 ----
    listTab: 'all', // all | available | used
    pool: [],
    filteredPool: [],
    emptyTitle: '暂无记录', // 首帧就有值，避免空态标题闪 undefined
    loading: true,

    // ---- 复制弹窗 ----
    modal: {
      visible: false,
      code: '',
    },
  },

  onLoad() {
    this.loadData();
  },

  // 首屏加载：三个接口并行拉，互不阻塞
  async loadData() {
    this.setData({ loading: true });
    const [statsRes, pool, records] = await Promise.all([
      api.fetchStats(),
      api.fetchPool(),
      api.fetchMyRecords(),
    ]);
    // 「可用」以服务端返回为准，不从本地列表数 —— 本地列表只是展示
    this.setData({
      stats: {
        todayCount: statsRes.todayCount,
        availableCount: statsRes.availableCount,
        totalText: statsRes.totalText,
      },
      pool,
      mySubmitted: records.submitted,
      myCopied: records.copied,
      loading: false,
    });
    this.applyFilter();
  },

  // ---- 发码表单 ----
  onInput(e) {
    this.setData({ inputCode: e.detail.value });
  },

  async onSubmit() {
    const code = (this.data.inputCode || '').trim();
    // 校验：只允许 8/9 位纯数字 —— 前端先挡一道，服务端还要再校验
    if (!/^\d{8,9}$/.test(code)) {
      wx.showToast({ title: '请输入 8/9 位数字组队码', icon: 'none' });
      return;
    }
    let item;
    try {
      item = await api.submitCode(code);
    } catch (err) {
      // 服务端拒绝（校验不过/频控/云函数未部署）：把原因告诉用户
      wx.showToast({ title: err.message || '提交失败', icon: 'none', duration: 2500 });
      return;
    }
    const pool = [item, ...this.data.pool];
    this.setData({
      pool,
      inputCode: '',
      // 提交成功：发码人数 +1，新码可用所以可用数 +1
      stats: {
        ...this.data.stats,
        todayCount: this.data.stats.todayCount + 1,
        availableCount: this.data.stats.availableCount + 1,
      },
    });
    this.applyFilter();
    wx.showToast({ title: '已提交到互助池', icon: 'success' });
  },

  // ---- 折叠面板 ----
  toggleTutorial() {
    this.setData({ tutorialOpen: !this.data.tutorialOpen });
  },

  toggleRecords() {
    this.setData({ recordsOpen: !this.data.recordsOpen });
  },

  // ---- 我的记录 tab ----
  onMyTab(e) {
    this.setData({ myTab: e.currentTarget.dataset.tab });
  },

  // ---- 互助池 tab 过滤 ----
  onListTab(e) {
    this.setData({ listTab: e.currentTarget.dataset.tab });
    this.applyFilter();
  },

  // 把过滤逻辑收敛到一个方法：任何会改变池子的操作之后都调它
  applyFilter() {
    const tab = this.data.listTab;
    const pool = this.data.pool;
    let filtered = pool;
    if (tab === 'available') filtered = pool.filter((i) => i.status === 'available');
    if (tab === 'used') filtered = pool.filter((i) => i.status === 'used');

    // 「全部」里可用的码置顶：
    // 先按"可用(0) / 已用(1)"分组，组内保持原始顺序（原始顺序 = 时间倒序，新的在前）。
    // 用 index 做次级排序键，避免依赖不同引擎的 sort 稳定性。
    filtered = filtered
      .map((item, index) => ({ item, index }))
      .sort((a, b) => {
        const rankA = a.item.status === 'available' ? 0 : 1;
        const rankB = b.item.status === 'available' ? 0 : 1;
        if (rankA !== rankB) return rankA - rankB;
        return a.index - b.index;
      })
      .map((entry) => entry.item);

    // 空态标题按 tab 区分文案
    const emptyTitle =
      tab === 'available' ? '暂时没有可用码'
      : tab === 'used' ? '暂时没有已用记录'
      : '暂无记录';
    this.setData({ filteredPool: filtered, emptyTitle });
  },

  // ---- 账号状态查询 ----
  // 当前账号的风控状态（正常/受限/封禁），后续由服务端接口返回
  onCheckAccount() {
    wx.showToast({
      title: '当前账号状态' + this.data.accountStatus,
      icon: 'none',
    });
  },

  // ---- 空态引导 ----
  // "去发一个码"：滚回顶部并聚焦输入框，让用户直接开始输入
  onGoSubmit() {
    wx.pageScrollTo({ scrollTop: 0, duration: 300 });
    this.setData({ focusInput: true });
    // focus 属性置 true 后由键盘接管，稍后复位，避免下次进入页面自动弹键盘
    setTimeout(() => this.setData({ focusInput: false }), 800);
  },

  // "查看全部记录"：切回全部 tab
  onSeeAll() {
    this.setData({ listTab: 'all' });
    this.applyFilter();
  },

  // ---- 复制：弹窗展示完整码 + 写入剪贴板 + 标记已用 ----
  async onCopy(e) {
    const id = e.currentTarget.dataset.id;
    const item = this.data.pool.find((i) => i.id === id);
    if (!item) return;

    // 先弹窗、写剪贴板，再把状态置为已用并刷新过滤列表
    this.setData({ modal: { visible: true, code: item.codeFull } });
    wx.setClipboardData({
      data: item.codeFull,
      success: () => {
        // 剪贴板写入成功后微信会自动弹 toast，这里不用再提示
      },
    });

    await api.markUsed(id);
    api.saveCopiedRecord(item); // 复制记录存本地，供"我复制的"展示
    const pool = this.data.pool.map((i) =>
      i.id === id ? { ...i, status: 'used' } : i
    );
    const myCopied = [
      {
        id: 'copy-' + id,
        codeMasked: item.codeMasked,
        dateText: item.timeText,
        reportable: true,
      },
      ...this.data.myCopied,
    ];
    this.setData({
      pool,
      myCopied,
      // 复制即视为已被领取：如果复制的是可用码，可用数 -1（相对变化，不重算）
      stats: {
        ...this.data.stats,
        availableCount: Math.max(
          0,
          this.data.stats.availableCount - (item.status === 'available' ? 1 : 0)
        ),
      },
    });
    this.applyFilter();
  },

  onCloseModal() {
    this.setData({ modal: { visible: false, code: '' } });
  },

  // 阻止弹窗内容区的点击冒泡到遮罩层（WXML 里用 catchtap）
  stopBubble() {},

  // ---- 举报 ----
  // 举报链路：用户选理由 → 上报(码id + 理由 + 举报人) →
  // 服务端给这条码累计举报数，超过阈值自动下架，并给提交者扣信用分/限制发码。
  onReport(e) {
    const id = e.currentTarget.dataset.id || '';
    wx.showActionSheet({
      itemList: ['码无法使用', '码已过期', '广告或恶意码', '其他问题'],
      success: (res) => {
        if (res.tapIndex === 3) {
          // 「其他问题」给自由描述入口 —— 自由文本是内容安全重点区域，
          // 先过 secCheck 云函数校验，risky 直接拦截
          wx.showModal({
            title: '描述一下问题',
            editable: true,
            placeholderText: '选填，说说什么情况',
            success: (m) => {
              if (!m.confirm) return;
              this.doReport(id, 3, m.content || '');
            },
          });
          return;
        }
        this.doReport(id, res.tapIndex);
      },
    });
  },

  async doReport(id, reasonIndex, extraText) {
    const res = await api.reportCode(id, reasonIndex, extraText);
    if (res.blocked) {
      wx.showToast({ title: res.errMsg || '描述含违规内容，无法提交', icon: 'none', duration: 2500 });
      return;
    }
    if (!res.accepted) {
      wx.showToast({ title: '举报失败，请稍后再试', icon: 'none' });
      return;
    }
    // 云端真实状态：举报数 +1；达到 3 次才真正下架（removed 时才从列表移除）
    if (!res.removed) {
      wx.showToast({ title: '已提交举报，感谢反馈', icon: 'none' });
      return;
    }
    const removed = this.data.pool.find((i) => i.id === id);
    const pool = this.data.pool.filter((i) => i.id !== id);
    this.setData({
      pool,
      // 下架的是可用码时，可用数 -1
      stats: {
        ...this.data.stats,
        availableCount: Math.max(
          0,
          this.data.stats.availableCount -
            (removed && removed.status === 'available' ? 1 : 0)
        ),
      },
    });
    this.applyFilter();
    wx.showToast({ title: '该码已被多人举报，已下架', icon: 'none' });
  },

  // ---- 下拉刷新 ----
  async onPullDownRefresh() {
    await this.loadData();
    wx.stopPullDownRefresh();
    wx.showToast({ title: '已刷新', icon: 'none' });
  },

  // ---- 转发分享 ----
  onShareAppMessage() {
    return {
      title: '组队 - 组队码互助池',
      path: '/pages/index/index',
    };
  },
});
