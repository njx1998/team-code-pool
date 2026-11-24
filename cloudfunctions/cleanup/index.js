/**
 * cleanup —— 清空 codes 集合（开发调试用）
 *
 * 安全锁：必须显式传 {"confirm":"YES"} 才执行，防误触发。
 * 用途：清掉测试提交，恢复当日频控配额。
 * 上线前应删除本函数，避免留在生产环境。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const MAX_LOOP = 20; // 每轮取 100 条，最多 20 轮 = 2000 条，防死循环

exports.main = async (event) => {
  // ---- 安全锁 ----
  if (event.confirm !== 'YES') {
    return {
      ok: false,
      errMsg: '安全锁：必须传 {"confirm":"YES"} 才会执行删除',
    };
  }

  let deleted = 0;
  for (let i = 0; i < MAX_LOOP; i++) {
    const res = await db.collection('codes').limit(100).get();
    if (!res.data.length) break;
    for (const doc of res.data) {
      await db.collection('codes').doc(doc._id).remove();
      deleted++;
    }
  }

  return { ok: true, deleted, note: 'codes 集合已清空，当日频控配额立即恢复' };
};
