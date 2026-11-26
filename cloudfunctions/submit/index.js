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

exports.main = async (event) => {
  if (event.action === 'report') return doReport(event);
  if (event.action === 'use') return doUse(event);
  return doSubmit(event);
};

// ==================== 提交组队码 ====================

/**
 * 内容安全校验：只有含「非数字」字符的内容才真正走 msgSecCheck。
 *
 * 提交的组队码是 8/9 位纯数字，没有任何文本语义，调内容安全接口既不产生有效
 * 结论、又要多等一次外部 HTTPS 往返（实测 100~600ms，是提交延迟的大头）。
 * 以后加了备注/昵称等自由文本字段，非数字内容会自动走这里的校验分支。
 * 需要强制全量校验时把开关改回 true 即可。
 */
const SEC_CHECK_NUMERIC = false;

async function checkText(openid, content) {
  if (!SEC_CHECK_NUMERIC && !/[^0-9]/.test(content)) return 'skipped';
  try {
    const sec = await cloud.openapi.security.msgSecCheck({
      openid,
      scene: 3, // 1 资料 2 评论 3 论坛 4 社交日志
      version: 2,
      content,
    });
    return (sec.result && sec.result.suggest) || 'pass';
  } catch (e) {
    // 安全接口异常不拦截提交（可用性优先），留日志
    console.error('[submit] msgSecCheck 调用失败:', e.errCode, e.errMsg || e.message);
    return 'unknown';
  }
}

async function doSubmit(event) {
  const { code } = event;
  const codeStr = String(code || '');

  // ---- 1. 格式校验：8/9 位纯数字 ----
  if (!/^\d{8,9}$/.test(codeStr)) {
    return { ok: false, errCode: 'INVALID_CODE', errMsg: '组队码必须是 8/9 位数字' };
  }

  // ---- 2. 调用者身份 ----
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, errCode: 'NO_AUTH', errMsg: '无法获取用户身份' };
  }

  // ---- 3. 三项前置校验并发执行 ----
  // 频控 / 查重 / 内容安全彼此不依赖，原来是串行 await 三次，
  // 白白多花两三次往返。并发后总耗时 = 最慢的那一项。
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const [limitRes, dupRes, secSuggest] = await Promise.all([
    db
      .collection('codes')
      .where({ openid: OPENID, createdAt: _.gte(todayStart) })
      .count()
      .catch((e) => {
        console.warn('[submit] 频控查询失败:', e.message); // 不拦截主流程
        return null;
      }),
    db
      .collection('codes')
      .where({ code: codeStr, status: _.neq('removed') })
      .count()
      .catch((e) => {
        console.warn('[submit] 查重失败:', e.message); // 不拦截主流程
        return null;
      }),
    checkText(OPENID, codeStr),
  ]);

  if (limitRes && limitRes.total >= DAILY_LIMIT) {
    return { ok: false, errCode: 'RATE_LIMIT', errMsg: '今天提交次数已达上限，明天再来吧' };
  }
  // 同一个码已在池中（未下架）不许重复提交；被举报下架的码允许重新提交
  if (dupRes && dupRes.total > 0) {
    return { ok: false, errCode: 'DUPLICATE', errMsg: '这个码已经在互助池里了，不用重复提交' };
  }
  if (secSuggest === 'risky') {
    return { ok: false, errCode: 'CONTENT_RISKY', errMsg: '内容含违规信息，已被拦截' };
  }

  // ---- 4. 写入数据库 ----
  const res = await db.collection('codes').add({
    data: {
      code: codeStr,
      status: 'available',
      reports: 0,
      openid: OPENID, // 服务端 add 不自动带 _openid，手动记录
      secSuggest, // pass / review / unknown / skipped（纯数字跳过校验）
      createdAt: db.serverDate(),
    },
  });

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
