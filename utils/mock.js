/**
 * mock.js —— 假数据生成器
 *
 * 学习要点：真实项目中这些数据来自服务端接口。
 * 这里用随机生成模拟"互助池"的数据流转，接口形态与真实后端保持一致，
 * 这样将来接入真接口时，只需要替换 request.js 里的实现，页面代码一行不用改。
 */

// 区间随机整数（含两端）
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// 生成一串数字码，长度 8 或 9（对应 PDD 组队码的两种长度）
function genCode(len) {
  let s = '';
  for (let i = 0; i < len; i++) {
    s += rand(0, 9);
  }
  return s;
}

// 掩码展示：前 3 位 + ** + 后 4 位，例如 278**3386
// 学习要点：敏感信息只在展示层打码，完整数据仍需传给需要的地方
function maskCode(code) {
  return code.slice(0, 3) + '**' + code.slice(-4);
}

// 来源 IP 掩码：182.**.120
function maskIp() {
  return rand(36, 223) + '.**.' + rand(2, 250);
}

// 相对时间文案
function timeAgoText(minutesAgo) {
  if (minutesAgo <= 0) return '刚刚';
  return minutesAgo + '分钟前';
}

// 历史记录的日期文案，例如 11-15 23:15
function dateText(daysAgo) {
  const d = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const h = rand(20, 23);
  const m = pad(rand(0, 59));
  return (d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + h + ':' + m;
}

let seq = 1;

// 生成一条互助池记录
// status: 'available' 可用 / 'used' 已被领取
function makePoolItem(minutesAgo, status) {
  const code = genCode(9);
  return {
    id: 'pool-' + seq++,
    codeFull: code,          // 完整码：复制弹窗里展示
    codeMasked: maskCode(code), // 掩码：列表里展示
    digits: code.length,
    timeText: timeAgoText(minutesAgo),
    ipMasked: maskIp(),
    status: status,
  };
}

// 互助池初始数据：越新的排越前面，大部分已被领取（符合"刚发出来就被抢"的观感）
function seedPool(count) {
  const list = [];
  let minutes = 0;
  for (let i = 0; i < count; i++) {
    // 大约每 6 条里有 1 条可用
    const status = i % 6 === 2 ? 'available' : 'used';
    list.push(makePoolItem(minutes, status));
    minutes += rand(0, 2); // 时间逐渐往前推
  }
  return list;
}

// "我提交的"记录
function makeSubmittedItem(daysAgo) {
  const code = genCode(9);
  return {
    id: 'sub-' + seq++,
    codeMasked: maskCode(code),
    dateText: dateText(daysAgo),
  };
}

// "我复制的"记录（可举报）
function makeCopiedItem(daysAgo) {
  return {
    id: 'copy-' + seq++,
    codeMasked: maskCode(genCode(9)),
    dateText: dateText(daysAgo),
    timeText: timeAgoText(rand(0, 30)),
    ipMasked: maskIp(),
    digits: 9,
  };
}

function seedMySubmitted() {
  const list = [];
  let days = 0;
  for (let i = 0; i < 8; i++) {
    list.push(makeSubmittedItem(days));
    if (i % 2 === 1) days += 1;
  }
  return list;
}

function seedMyCopied() {
  const list = [];
  for (let i = 0; i < 8; i++) {
    list.push(makeCopiedItem(Math.floor(i / 3)));
  }
  return list;
}

module.exports = {
  rand,
  genCode,
  maskCode,
  maskIp,
  makePoolItem,
  seedPool,
  seedMySubmitted,
  seedMyCopied,
};
