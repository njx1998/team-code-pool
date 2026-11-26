/**
 * purge —— 定时清理（云存储降耗）
 *
 * 两个职责：
 * 1. 日常模式（daily-purge 触发器，每天 04:00）：删除 14 天前的已用/下架码
 * 2. 一次性全量清理（oneshot-clear 触发器）：仅在 ONE_SHOT_DATE 当天触发时
 *    清空整个 codes 集合 —— 有日期锁，之后即使触发器残留也不会再清，
 *    自动退化为日常模式。确认生效后可从 config.json 移除该触发器。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const RETAIN_DAYS = 14; // 已用/下架码保留天数
const BATCH = 100; // 每轮删除条数
const MAX_LOOP = 50; // 单次最多 50 轮，防超时
const ONE_SHOT_DATE = '2026-11-26'; // 全量清理仅限这一天（北京时间）
const FULL_CLEAR_TRIGGERS = ['oneshot-clear'];

exports.main = async (event = {}) => {
  const trigger = event.TriggerName || '';
  const bjDate = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
  const fullClear = FULL_CLEAR_TRIGGERS.includes(trigger) && bjDate === ONE_SHOT_DATE;

  let deleted = 0;
  if (fullClear) {
    // 全量清空：分批删到集合为空
    for (let i = 0; i < 100; i++) {
      const res = await db.collection('codes').limit(BATCH).remove();
      const n = res.stats.removed || 0;
      deleted += n;
      if (n < BATCH) break;
    }
    console.log('[purge] 全量清空 codes:', deleted);
    return { ok: true, mode: 'full-clear', deleted };
  }

  // ---- 日常模式：只删过期的已用/下架码 ----
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000);
  for (let i = 0; i < MAX_LOOP; i++) {
    const res = await db
      .collection('codes')
      .where({ status: _.in(['used', 'removed']), createdAt: _.lt(cutoff) })
      .limit(BATCH)
      .remove();
    const n = res.stats.removed || 0;
    deleted += n;
    if (n < BATCH) break;
  }

  console.log('[purge] 删除过期码:', deleted, 'cutoff:', cutoff.toISOString());
  return { ok: true, mode: 'daily', deleted, cutoff: cutoff.toISOString() };
};
