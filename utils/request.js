/**
 * request.js —— 数据请求层（微信云开发 · 云数据库版）
 *
 * 1. 页面永远只调这一层的 API，不直接碰数据来源 —— 这层换了实现，页面一行不用改。
 * 2. 云数据库客户端直连：写入的文档会自动带上 _openid（提交者身份），
 *    查询/修改受集合安全规则约束。
 * 3. 写操作的频控、黑名单、举报防刷等校验，后续通过云函数在服务端完成。
 *
 * 数据结构（集合 codes）：
 *   {
 *     code: '283809300',      // 完整组队码
 *     status: 'available',    // available 可用 / used 已用 / removed 已下架
 *     reports: 0,             // 累计举报次数
 *     createdAt: Date         // 提交时间（serverDate 服务端时间）
 *   }
 */

// 云数据库引用（app.js 里 wx.cloud.init 之后可用）
const db = wx.cloud.database();
const cmd = db.command;

// ==================== 工具函数 ====================

// 掩码展示：前 3 位 + ** + 后 4 位，例如 278**3386
// 敏感信息只在展示层打码，完整数据仍需传给需要的地方
function maskCode(code) {
  return code.slice(0, 3) + '**' + code.slice(-4);
}

// 相对时间文案：刚刚 / 5分钟前 / 3小时前 / 2天前
function timeAgo(ts) {
  const mins = Math.floor((Date.now() - new Date(ts).getTime()) / 60000);
  if (mins <= 0) return '刚刚';
  if (mins < 60) return mins + '分钟前';
  const h = Math.floor(mins / 60);
  if (h < 24) return h + '小时前';
  return Math.floor(h / 24) + '天前';
}

// 绝对时间文案：11-23 22:15
function fmtTime(ts) {
  const d = new Date(ts);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 云文档 → 页面列表项的统一格式（页面只认这个形状）
function toPoolItem(doc) {
  return {
    id: doc._id,
    codeFull: doc.code,
    codeMasked: maskCode(doc.code),
    digits: doc.code.length,
    timeText: timeAgo(doc.createdAt),
    ipMasked: '', // 客户端拿不到真实 IP；需要 IP 时由云函数在服务端获取
    status: doc.status,
  };
}

// 集合可能还没创建：包一层，失败时返回默认值并在控制台留原因，
// 页面照常渲染空态，不至于卡在 loading
async function safe(fn, fallback) {
  try {
    return await fn();
  } catch (err) {
    console.error('[云数据库调用失败]', err.errCode || '', err.errMsg || err.message || err);
    if (String(err.errMsg || '').indexOf('collection') > -1) {
      wx.showToast({ title: '请先在云控制台创建集合 codes', icon: 'none', duration: 3000 });
    }
    return fallback;
  }
}

// ==================== 接口 ====================

// 顶部统计：今日发码人数 / 可用数 / 累计提交数
// 三个数字都是对 codes 集合的真实计数 —— 数据库为空时自然从 0 开始
async function fetchStats() {
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  return safe(async () => {
    const [today, avail, total] = await Promise.all([
      db.collection('codes').where({ createdAt: cmd.gte(todayStart) }).count(),
      db.collection('codes').where({ status: 'available' }).count(),
      db.collection('codes').count(),
    ]);
    return {
      todayCount: today.total,
      availableCount: avail.total,
      totalText: String(total.total),
    };
  }, { todayCount: 0, availableCount: 0, totalText: '0' });
}

// 互助池列表：最近 20 条未下架的码，按提交时间倒序
async function fetchPool() {
  return safe(async () => {
    const res = await db
      .collection('codes')
      .where({ status: cmd.neq('removed') })
      .orderBy('createdAt', 'desc')
      .limit(20)
      .get();
    return res.data.map(toPoolItem);
  }, []);
}

// 我的记录：我提交的 + 我复制的
// 说明：客户端直连拿不到 openid（要云函数），所以"我的"记录存在本地
// storage 里（id/码/时间戳），展示时用时间戳动态生成文案。
// 换设备不同步 —— 想跨设备就后续把查询搬进云函数。
async function fetchMyRecords() {
  const submitted = (wx.getStorageSync('mySubmitted') || []).map((it) => ({
    id: it.id,
    codeMasked: it.codeMasked,
    dateText: fmtTime(it.ts),
  }));
  const copied = (wx.getStorageSync('myCopied') || []).map((it) => ({
    id: it.id,
    codeMasked: it.codeMasked,
    dateText: timeAgo(it.ts),
    reportable: true,
  }));
  return { submitted, copied };
}

// 提交一个组队码：走云函数 submit（服务端校验 + 频控 + 入库），返回页面格式的池记录
// 云函数负责真正的拦截：格式校验、一人一天 10 条频控、身份记录
async function submitCode(code) {
  const res = await wx.cloud.callFunction({ name: 'submit', data: { code } });
  const r = res.result || {};
  if (!r.ok) {
    const err = new Error(r.errMsg || '提交失败，请稍后再试');
    err.errCode = r.errCode;
    throw err;
  }

  const item = {
    id: r.id,
    codeFull: code,
    codeMasked: maskCode(code),
    digits: code.length,
    timeText: '刚刚',
    ipMasked: '',
    status: 'available',
  };

  // 记进本地"我提交的"（最多留 50 条）
  const list = wx.getStorageSync('mySubmitted') || [];
  list.unshift({ id: addRes._id, codeMasked: item.codeMasked, ts: Date.now() });
  wx.setStorageSync('mySubmitted', list.slice(0, 50));

  return item;
}

// 把复制的码记进本地"我复制的"（页面在复制成功后调用）
function saveCopiedRecord(item) {
  const list = wx.getStorageSync('myCopied') || [];
  list.unshift({
    id: 'copy-' + item.id,
    codeMasked: item.codeMasked,
    ts: Date.now(),
  });
  wx.setStorageSync('myCopied', list.slice(0, 50));
}

// 标记某条码为"已用"（复制后即视为已被领取）
async function markUsed(id) {
  await db.collection('codes').doc(id).update({
    data: { status: 'used' },
  });
  return { id };
}

// 举报一条码：举报数 +1（原子自增），满 3 次自动下架
// extraText：「其他问题」的自由描述 —— 非空时先过 secCheck 云函数内容安全校验
async function reportCode(id, reasonIndex, extraText) {
  const reasons = ['码无法使用', '码已过期', '广告或恶意码', '其他问题'];

  const text = String(extraText || '').trim();
  if (text) {
    try {
      const secRes = await wx.cloud.callFunction({
        name: 'secCheck',
        data: { content: text, scene: 2 }, // scene 2 = 评论场景
      });
      const r = secRes.result || {};
      if (r.ok && !r.passed) {
        // risky / review 都不给提交 —— 保守策略：人工复审期间的违规文本也不该入库
        return { accepted: false, blocked: true, errMsg: '描述含违规内容，无法提交' };
      }
      if (!r.ok) {
        // 接口异常不拦截举报主流程（与 submit 的可用性策略一致），留痕
        console.error('[report] secCheck 校验异常:', r.errMsg, r.apiErrCode);
      }
    } catch (e) {
      console.error('[report] secCheck 网络失败:', e.message);
    }
  }

  const docRef = db.collection('codes').doc(id);
  const doc = await docRef.get();
  const reports = (doc.data && doc.data.reports ? doc.data.reports : 0) + 1;

  const update = { data: { reports: cmd.inc(1) } };
  const removed = reports >= 3;
  if (removed) update.data.status = 'removed'; // 到阈值：下架（列表里不再出现）
  await docRef.update(update);

  return { id, reason: reasons[reasonIndex], accepted: true, removed };
}

module.exports = {
  fetchStats,
  fetchPool,
  fetchMyRecords,
  submitCode,
  saveCopiedRecord,
  markUsed,
  reportCode,
};
