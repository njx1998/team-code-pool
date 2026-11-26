/**
 * submit —— 写操作统一云函数（action 分发）
 *
 * 一次部署覆盖三类写操作，减少函数数量与冷启动：
 *   - action 缺省  → 提交组队码
 *   - action 'report' → 举报（服务端原子计数 + 满阈值自动下架）
 *   - action 'use'   → 复制后置已用（仅 available 可置 used）
 *
 * 升级点（相对客户端直连数据库）：
 * 1. 服务端校验 —— 客户端的校验只是体验优化，真正的拦截在这里
 * 2. 频控 —— 同一用户一天最多提交 10 条，防灌水
 * 3. 身份记录 —— 服务端显式写入 openid（服务端 add 不会自动带，必须手动存）
 * 4. 服务端时间戳 —— 不信客户端时间
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const DAILY_LIMIT = 10; // 一人一天最多提交数
const REPORT_THRESHOLD = 3; // 举报满 3 次自动下架
const RETAIN_DAYS = 14; // 已用/下架码保留天数（与 purge 云函数保持一致）

exports.main = async (event) => {
  if (event.action === 'report') return doReport(event);
  if (event.action === 'use') return doUse(event);
  return doSubmit(event);
};

/**
 * 惰性清理：不依赖定时触发器。
 * 云数据库不会自动过期，已用/下架的码堆着只会拖慢查询、占存储。
 * 每次成功提交后顺带删一批 14 天前的废弃码 —— 没有可删对象时 remove 返回
 * removed:0，成本就是一次极小的写请求，可以忽略。
 * 即使没配触发器的 purge 也照样能收敛集合体积（purge 负责大批量，这里负责保底）。
 */
async function lazyPurge() {
  const cutoff = new Date(Date.now() - RETAIN_DAYS * 86400000);
  try {
    const res = await db
      .collection('codes')
      .where({ status: _.in(['used', 'removed']), createdAt: _.lt(cutoff) })
      .limit(50)
      .remove();
    const n = (res.stats && res.stats.removed) || 0;
    if (n) console.log('[lazy-purge] 删除过期码:', n);
  } catch (e) {
    // 清理失败绝不能影响提交结果，只留日志
    console.warn('[lazy-purge] 跳过:', e.errMsg || e.message);
  }
}

// ==================== 提交组队码 ====================
async function doSubmit(event) {
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

  // ---- 3.5 查重：同一个码已在池中（未下架）就不许重复提交 ----
  // 防止同一码刷屏占位；被举报下架（removed）的码允许重新提交
  try {
    const dup = await db
      .collection('codes')
      .where({ code: String(code), status: _.neq('removed') })
      .count();
    if (dup.total > 0) {
      return {
        ok: false,
        errCode: 'DUPLICATE',
        errMsg: '这个码已经在互助池里了，不用重复提交',
      };
    }
  } catch (e) {
    console.warn('[submit] 查重失败:', e.message); // 查重失败不拦截主流程
  }

  // ---- 4. 内容安全校验（msgSecCheck v2）----
  // 提交码目前是纯数字，天然低风险；这里校验是为了：(a) 平台合规硬要求 ——
  // 用户产生内容必须过安全接口；(b) 未来加备注/昵称等文本字段时这里已经兜住。
  // 注意：config.json 里必须声明 openapi 权限 security.msgSecCheck，否则报 -604103。
  try {
    const sec = await cloud.openapi.security.msgSecCheck({
      openid: OPENID,
      scene: 3, // 1 资料 2 评论 3 论坛 4 社交日志
      version: 2,
      content: String(code),
    });
    const suggest = (sec.result && sec.result.suggest) || 'pass';
    if (suggest === 'risky') {
      return {
        ok: false,
        errCode: 'CONTENT_RISKY',
        errMsg: '内容含违规信息，已被拦截',
      };
    }
    // suggest === 'review'（需人工复审）: 保守起见也放行入库，但打标
    var secSuggest = suggest;
  } catch (e) {
    // 安全接口异常不拦截提交（可用性优先），留日志 —— 但要在云控制台关注该告警
    console.error('[submit] msgSecCheck 调用失败:', e.errCode, e.errMsg || e.message);
    var secSuggest = 'unknown';
  }

  // ---- 5. 写入数据库 ----
  const res = await db.collection('codes').add({
    data: {
      code: String(code),
      status: 'available',
      reports: 0,
      openid: OPENID, // 服务端 add 不自动带 _openid，手动记录
      secSuggest, // 内容安全结论：pass / review / unknown（接口异常时）
      createdAt: db.serverDate(),
    },
  });

  // 顺手清理过期废弃码（不阻塞也不影响提交结果，函数内 await 保证执行完）
  await lazyPurge();

  return { ok: true, id: res._id };
}

// ==================== 举报 ====================
/**
 * 举报链路在服务端一次完成：
 * 1. 自由描述非空时先过 msgSecCheck（risky/review 都拦 —— 保守策略）
 * 2. 原子条件更新：reports ≥ 2 的文档把本次举报连同下架一次写入，
 *    否则只做 reports +1。全程无「先读后写」窗口，并发举报不会少计。
 */
async function doReport(event) {
  const { id, reasonIndex, extraText } = event;

  if (!/^[0-9a-zA-Z_-]{1,64}$/.test(String(id || ''))) {
    return { ok: false, errCode: 'INVALID_ID', errMsg: '举报目标无效' };
  }

  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, errCode: 'NO_AUTH', errMsg: '无法获取用户身份' };
  }

  // ---- 1. 自由描述内容安全校验 ----
  const text = String(extraText || '').trim();
  if (text) {
    if (text.length > 200) {
      return { ok: false, errCode: 'TEXT_TOO_LONG', errMsg: '描述太长了，请精简后重试' };
    }
    try {
      const sec = await cloud.openapi.security.msgSecCheck({
        openid: OPENID,
        scene: 2, // 评论场景
        version: 2,
        content: text,
      });
      const suggest = (sec.result && sec.result.suggest) || 'pass';
      if (suggest !== 'pass') {
        return {
          ok: false,
          errCode: 'CONTENT_RISKY',
          errMsg: '描述含违规内容，无法提交',
        };
      }
    } catch (e) {
      // 安全接口异常不拦截举报主流程（可用性优先），留日志
      console.error('[report] msgSecCheck 调用失败:', e.errCode, e.errMsg || e.message);
    }
  }

  // ---- 2. 原子更新 ----
  // 先尝试「满阈值即下架」：命中 reports ≥ 2 且未下架的文档，+1 后恰好为 3
  const promote = await db
    .collection('codes')
    .where({ _id: id, reports: _.gte(REPORT_THRESHOLD - 1), status: _.neq('removed') })
    .update({ data: { reports: _.inc(1), status: 'removed' } });

  if (promote.stats.updated > 0) {
    return { ok: true, id, removed: true };
  }

  // 普通举报：reports +1（where 条件更新：目标不存在时返回 updated 0，不抛错）
  const incRes = await db
    .collection('codes')
    .where({ _id: id })
    .update({ data: { reports: _.inc(1) } });
  if (!incRes.stats.updated) {
    // 两次更新都没命中：文档不存在（可能已被定时清理），明确报错而不是静默成功
    return { ok: false, errCode: 'NOT_FOUND', errMsg: '该码不存在或已被清理' };
  }
  return { ok: true, id, removed: false };
}

// ==================== 复制后置已用 ====================
/**
 * 客户端对他人文档没有写权限（集合安全规则），置已用必须走服务端。
 * 原子条件更新：只有 status 仍为 available 才置 used，防并发误改。
 */
async function doUse(event) {
  const { id } = event;

  if (!/^[0-9a-zA-Z_-]{1,64}$/.test(String(id || ''))) {
    return { ok: false, errCode: 'INVALID_ID', errMsg: '目标无效' };
  }

  await db
    .collection('codes')
    .where({ _id: id, status: 'available' })
    .update({ data: { status: 'used' } });

  // 已被别人置过 used / 已下架的幂等返回成功 —— 复制动作本身已成功
  return { ok: true, id };
}
