/**
 * secCheck —— 通用文本内容安全校验（云函数）
 *
 * 走微信 openapi 的 security.msgSecCheck v2：
 *  - v2 必须带 openid（调用者身份）与 scene（内容场景）
 *  - 返回 result.suggest：pass 通过 / review 需人工复审 / risky 高风险
 *
 * 用途：用户产生的任意文本都要过一遍 —— 提交码、举报理由、未来加的昵称/评论等。
 * 提交码流程已在 submit 云函数里内联校验；这个独立函数供其他文本场景复用。
 */

const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

// 场景映射（openapi v2 规定）：1 资料 2 评论 3 论坛 4 社交日志
const SCENES = [1, 2, 3, 4];
const MAX_LEN = 2500; // v2 接口内容上限

exports.main = async (event) => {
  const { content, scene } = event;

  // ---- 1. 入参校验 ----
  const text = String(content || '').trim();
  if (!text) {
    return { ok: false, errCode: 'EMPTY', errMsg: '内容不能为空' };
  }
  if (text.length > MAX_LEN) {
    return { ok: false, errCode: 'TOO_LONG', errMsg: `内容不能超过 ${MAX_LEN} 字` };
  }
  const sc = SCENES.includes(Number(scene)) ? Number(scene) : 3; // 默认按论坛场景

  // ---- 2. 调用者身份 ----
  const { OPENID } = cloud.getWXContext();
  if (!OPENID) {
    return { ok: false, errCode: 'NO_AUTH', errMsg: '无法获取用户身份' };
  }

  // ---- 3. 调用微信内容安全接口 ----
  try {
    const res = await cloud.openapi.security.msgSecCheck({
      openid: OPENID,
      scene: sc,
      version: 2,
      content: text,
    });

    const suggest = (res.result && res.result.suggest) || 'pass';
    const label = res.result && res.result.label;

    return {
      ok: true,
      suggest,           // pass | review | risky
      label,             // 命中的风险类别（100 涉政、2000 色情等），通过时为空
      passed: suggest === 'pass',
    };
  } catch (e) {
    // openapi 报错：可能是权限未声明、频控或接口异常 —— 原样上报，不吞
    return {
      ok: false,
      errCode: 'API_ERROR',
      errMsg: e.errMsg || e.message,
      apiErrCode: e.errCode,
    };
  }
};
