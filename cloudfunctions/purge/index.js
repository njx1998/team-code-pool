/**
 * purge —— 定时清理（云存储降耗）
 *
 * 微信云数据库不支持 TTL 自动过期，集合会随时间无限膨胀：
 * 已用/下架的码留在库里只会拖慢 count 查询、占用存储配额。
 * 本函数由定时触发器每天凌晨 4 点调用，删除 14 天前的已用/下架码。
 *
 * 触发器配置见 config.json（triggers），部署时随函数一起上传。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const RETAIN_DAYS = 14; // 已用/下架码保留天数
const BATCH = 100; // 每轮删除条数
const MAX_LOOP = 50; // 单次最多 50 轮 = 5000 条，防超时

exports.main = async () => {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000);

  let deleted = 0;
  for (let i = 0; i < MAX_LOOP; i++) {
    const res = await db
      .collection('codes')
      .where({ status: _.in(['used', 'removed']), createdAt: _.lt(cutoff) })
      .limit(BATCH)
      .remove();
    const n = res.stats.removed || 0;
    deleted += n;
    if (n < BATCH) break; // 删干净了
  }

  console.log('[purge] 删除过期码:', deleted, 'cutoff:', cutoff.toISOString());
  return { ok: true, deleted, cutoff: cutoff.toISOString() };
};
