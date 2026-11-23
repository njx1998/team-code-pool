/**
 * request.js —— 数据请求层
 *
 * 学习要点：页面永远只调这一层的 API，不直接碰数据来源。
 * 现在每个方法内部走 mock；将来有真后端时，把方法体换成 wx.request 即可，
 * 页面代码不需要任何改动。这就是"前后端分离"里前端一侧的隔离做法。
 *
 * 换成真接口的示例：
 *   function fetchPool() {
 *     return new Promise((resolve, reject) => {
 *       wx.request({
 *         url: 'https://your-server.com/api/pool',
 *         success: (res) => resolve(res.data),
 *         fail: reject,
 *       });
 *     });
 *   }
 */

const mock = require('./mock');

// 模拟网络延迟，让 loading 状态真实可感
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// 顶部统计：今日发码人数 / 可用数 / 累计次数
// 这三个数字是服务端聚合出来的，前端不该自己算 —— 所以固定返回，
// 等接了真后端，把这里换成真实接口即可，页面代码不用动
async function fetchStats() {
  await delay(200);
  return {
    todayCount: 4401,   // 今天发码人数
    availableCount: 2,  // 当前可用码数量
    totalText: '84.5万', // 累计使用次数（展示层直接用文案）
  };
}

// 互助池列表
async function fetchPool() {
  await delay(300);
  return mock.seedPool(20);
}

// 我的记录：我提交的 + 我复制的
async function fetchMyRecords() {
  await delay(200);
  return {
    submitted: mock.seedMySubmitted(),
    copied: mock.seedMyCopied(),
  };
}

// 提交一个组队码到互助池
// 返回新建的池记录；真实项目中这里会做频控、黑名单校验
async function submitCode(code) {
  await delay(400);
  const item = mock.makePoolItem(0, 'available');
  // 用用户真实输入的码覆盖随机码，保证掩码与输入一致
  item.codeFull = code;
  item.codeMasked = mock.maskCode(code);
  item.digits = code.length;
  return item;
}

// 标记某条码为"已用"（复制后即视为已被领取）
async function markUsed(id) {
  await delay(100);
  return { id };
}

// 举报一条码
// 真实项目：POST /api/report，body 带 { codeId, reason, reporterOpenId }
// 服务端累计举报数，超过阈值下架该码并给提交者扣信用分；同一用户对同一码只能举报一次
async function reportCode(id, reasonIndex) {
  await delay(300);
  const reasons = ['码无法使用', '码已过期', '广告或恶意码', '其他问题'];
  return {
    id,
    reason: reasons[reasonIndex],
    accepted: true, // mock 永远受理；真实项目可能返回重复举报、频控等
  };
}

module.exports = {
  fetchStats,
  fetchPool,
  fetchMyRecords,
  submitCode,
  markUsed,
  reportCode,
};
