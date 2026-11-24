/**
 * submit —— 提交组队码（云函数版）
 *
 * 相比客户端直连数据库的升级点：
 * 1. 服务端格式校验 —— 客户端的校验只是体验优化，真正的拦截在这里
 * 2. 频控 —— 同一用户一天最多提交 10 条，防灌水
 * 3. 身份记录 —— 服务端显式写入 _openid（服务端 add 不会自动带，必须手动存）
 * 4. 服务端时间戳 —— 不信客户端时间
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DAILY_LIMIT = 10; // 一人一天最多提交数

exports.main = async (event) => {
  const { code } = event;

  // ---- 1. 格式校验：8/9 位纯数字 ----
  if (!/^\d{8,9}$/.test(String(code || ''))) {
    return { ok: false, errCode: 'INVALID_CODE', errMsg: '组队码必须是 8/9 位数字' };
  }

  // ---- 2. 调用者身份 ----
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, errCode: 'NO_AUTH', errMsg: '无法获取用户身份' };
  }

  // ---- 3. 频控：同一用户当天提交数 ----
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  try {
    const cnt = await db
      .collection('codes')
      .where({ openid: OPENID, createdAt: _.gte(todayStart) })
      .count();
    if (cnt.total >= DAILY_LIMIT) {
      return {
        ok: false,
        errCode: 'RATE_LIMIT',
        errMsg: '今天提交次数已达上限，明天再来吧',
      };
    }
  } catch (e) {
    // count 失败不拦截主流程，只在日志里留痕
    console.warn('[submit] 频控查询失败:', e.message);
  }

  // ---- 4. 写入数据库 ----
  const res = await db.collection('codes').add({
    data: {
      code: String(code),
      status: 'available',
      reports: 0,
      openid: OPENID, // 服务端 add 不自动带 _openid，手动记录
      createdAt: db.serverDate(),
    },
  });

  return { ok: true, id: res._id };
};
