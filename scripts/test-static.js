'use strict';
/**
 * 静态演示版业务回归
 *
 * 不依赖浏览器与服务器：直接在 Node 沙箱里执行 mock-api.js，
 * 捕获它对 window.fetch 的劫持，然后用 Node 的 fetch 打到这层拦截上，
 * 完整跑一遍 申领 → 导师审批 → 核定 → 发放 → 归还 → 核销。
 *
 * 目的是保证 GitHub Pages 上的演示版与本地 Node 版行为一致。
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };
const eq = (a, b, m) => ok(a === b, m + (a === b ? '' : `（实际 ${a}，期望 ${b}）`));

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'docs', 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const mockJs = scripts.find(s => s.includes('zz_demo_state_v1'));
if (!mockJs) { console.error('未在 docs/index.html 中找到 mock 适配层 ❌'); process.exit(1); }

// 沙箱：提供 window / localStorage / fetch 占位，setTimeout 用真实的
const store = {};
const sandbox = {
  console,
  setTimeout,
  Promise,
  JSON, Math, Number, String, Array, Object, Error, Date, RegExp, isNaN, parseInt, parseFloat,
  location: { reload() { sandbox.__reloaded = true; } },
};
sandbox.window = sandbox;
sandbox.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
sandbox.fetch = () => Promise.reject(new Error('真实网络请求不应发生'));

vm.createContext(sandbox);
vm.runInContext(mockJs, sandbox, { filename: 'mock-api.js' });

if (typeof sandbox.fetch !== 'function') { console.error('mock 未接管 fetch ❌'); process.exit(1); }
console.log('静态演示版适配层已加载，开始业务回归\n');

async function call(method, url, body, token) {
  const opt = {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (token || '') },
  };
  if (body !== undefined) opt.body = JSON.stringify(body);
  const r = await sandbox.fetch(url, opt);
  return { status: r.status, data: await r.json() };
}

const login = async (username) => {
  const r = await call('POST', '/api/login', { username, password: 'demo1234' });
  if (!r.data.token) throw new Error(username + ' 登录失败：' + r.data.error);
  return r.data.token;
};

(async () => {
  // ---------- 1. 登录与角色 ----------
  console.log('[1] 登录与角色');
  const stu = await login('stu001');
  const stu2 = await login('stu002');
  const mentor = await login('mentor01');
  const wh = await login('wh006');
  const whOther = await login('wh005');
  const adm = await login('adm001');
  ok(stu.startsWith('demo-'), '学生登录返回演示 token');
  const me = await call('GET', '/api/me', undefined, stu);
  eq(me.data.user.name, '张同学', '/api/me 返回当前用户');
  ok(me.data.authMode.includes('LocalAuth'), '认证模式标注为演示适配器');
  const bad = await call('POST', '/api/login', { username: 'stu001', password: 'wrong' });
  ok(bad.status === 401, '错误口令被拒绝');
  const noUser = await call('POST', '/api/login', { username: '不存在', password: 'demo1234' });
  ok(noUser.status === 401, '不存在的用户被拒绝');
  const noTok = await call('GET', '/api/materials');
  ok(noTok.status === 401, '未带 token 被拒绝');

  // ---------- 2. 物资与负责人路由 ----------
  console.log('\n[2] 物资与负责人路由');
  const mats = await call('GET', '/api/materials', undefined, stu);
  eq(mats.data.length, 18, `学生可见 18 种物资（实际 ${mats.data.length}）`);
  const whMats = await call('GET', '/api/materials', undefined, wh);
  ok(whMats.data.every(m => m.owner_name === '车队楼张师傅'),
    '张巧玲只看到自己负责的物资（' + whMats.data.length + ' 种）');
  ok(whMats.data.length < 18, '仓库老师看不到全部物资');
  const otherMats = await call('GET', '/api/materials', undefined, whOther);
  ok(!whMats.data.some(m => otherMats.data.some(o => o.id === m.id)),
    '两位负责老师的物资集合不重叠');
  const desks = mats.data.filter(m => m.name === '长条桌');
  eq(desks.length, 3, '长条桌 3 种规格独立建模');
  ok(new Set(desks.map(d => d.size)).size === 3, '三种规格互不相同：' + desks.map(d => d.size).join(' / '));
  const matsTotal = mats.data.reduce((a, m) => a + m.available, 0);
  console.log(`       账面库存合计 ${matsTotal} 件`);

  // ---------- 3. 申领 → 导师审批 ----------
  console.log('\n[3] 申领 → 导师审批');
  const target = whMats.data[0];
  const create = await call('POST', '/api/requests', {
    material_id: target.id, apply_qty: 20, purpose: '静态演示验证',
    use_start: '2026-10-20', use_end: '2026-10-25',
    borrower: '张同学', phone: '13800000000', deposit_note: '学生证抵押',
  }, stu);
  ok(create.status === 200, '学生提交申领成功');
  const r1 = create.data;
  eq(r1.status_text, '待导师审批', '新单进入待导师审批');
  eq(r1.owner_name, '车队楼张师傅', '单据已按物资路由到负责老师');
  ok(/^ZX\d{8}-\d{3}$/.test(r1.code), '单号格式规范：' + r1.code);
  const oversell = await call('POST', '/api/requests', {
    material_id: target.id, apply_qty: 999999, purpose: '越界测试',
  }, stu);
  ok(oversell.status === 400, '超出可申领数量被拒绝：' + oversell.data.error);
  const badQty = await call('POST', '/api/requests', { material_id: target.id, apply_qty: 0 }, stu);
  ok(badQty.status === 400, '申请数量为 0 被拒绝');
  const notStudent = await call('POST', '/api/requests', { material_id: target.id, apply_qty: 1 }, wh);
  ok(notStudent.status === 400, '仓库老师不能替学生申领');

  const mentorList = await call('GET', '/api/requests', undefined, mentor);
  ok(mentorList.data.some(x => x.id === r1.id), '导师能看到待审批单据');
  const noApprove = await call('POST', '/api/requests/check', { id: r1.id, approved_qty: 20 }, whOther);
  ok(noApprove.status === 400, '非负责老师无法核定：' + noApprove.data.error);

  const approve = await call('POST', '/api/requests/mentor', { id: r1.id, pass: true, note: '同意' }, mentor);
  eq(approve.data.status_text, '待仓库核库存', '导师通过后进入待核定');
  const doubleApprove = await call('POST', '/api/requests/mentor', { id: r1.id, pass: true }, mentor);
  ok(doubleApprove.status === 400, '重复审批被拒绝');

  // ---------- 4. 核定：完全通过与部分通过 ----------
  console.log('\n[4] 核定：完全通过 / 部分通过改单');
  const availBefore = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id).available;

  // 部分通过
  const c2 = await call('POST', '/api/requests', { material_id: target.id, apply_qty: 30, purpose: '部分通过验证' }, stu);
  const r2 = c2.data;
  await call('POST', '/api/requests/mentor', { id: r2.id, pass: true }, mentor);
  const part = await call('POST', '/api/requests/check', { id: r2.id, approved_qty: 12 }, wh);
  eq(part.data.request.status_text, '部分通过已终止', '核定小于申请数 → 原单部分通过终止');
  ok(part.data.created && part.data.created.id !== r2.id, '生成改单 ' + (part.data.created && part.data.created.code));
  eq(part.data.created.apply_qty, 12, '改单申请数量按核定数写入');
  eq(part.data.created.status_text, '待导师审批', '改单回到导师审批');
  const afterReserve = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id);
  eq(afterReserve.reserved, 12, '核定即预占 12（改单待核定，尚未占用可发放量）');
  eq(afterReserve.available, availBefore, '预占不改账面可用，只加 reserved');
  const reservedAfterR1 = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id);
  eq(reservedAfterR1.reserved, 12, 'r1 核定前，改单预占仍为 12');

  // 完全通过
  const full = await call('POST', '/api/requests/check', { id: r1.id, approved_qty: 20 }, wh);
  eq(full.data.status_text, '待发放', '完全通过 → 待发放');
  eq(full.data.approved_qty, 20, '核定数量写入 20');
  const reservedBoth = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id);
  eq(reservedBoth.reserved, 32, '两张单核定后累计预占 32（12 + 20）');
  eq(reservedBoth.available - reservedBoth.reserved, availBefore - 32, '可发放量相应减少 32');

  // 改单走完流程
  await call('POST', '/api/requests/mentor', { id: part.data.created.id, pass: true }, mentor);
  const chk2 = await call('POST', '/api/requests/check', { id: part.data.created.id, approved_qty: 12 }, wh);
  eq(chk2.data.status_text, '待发放', '改单核定通过 → 待发放');

  // ---------- 5. 发放 ----------
  console.log('\n[5] 发放：按实发扣库存');
  const over = await call('POST', '/api/requests/issue', { id: r1.id, issued_qty: 25 }, wh);
  ok(over.status === 400, '实发超过核定被拒绝：' + over.data.error);
  const avail2 = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id).available;
  const issued = await call('POST', '/api/requests/issue', { id: r1.id, issued_qty: 18, deposit_note: '学生证抵押' }, wh);
  eq(issued.data.status, 'in_use', '发放后进入借用中');
  eq(issued.data.issued_qty, 18, '实发数量 18');
  const avail3 = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id).available;
  eq(avail3, avail2 - 18, `库存按实发扣减：${avail2} → ${avail3}`);

  // ---------- 6. 归还两步流程 ----------
  console.log('\n[6] 归还：学生申报 + 老师清点');
  const noPhoto = await call('POST', '/api/requests/return-submit', { id: r1.id, declared_qty: 18, photos: [] }, stu);
  ok(noPhoto.status === 400, '无照片提交归还被拒绝：' + noPhoto.data.error);
  const over2 = await call('POST', '/api/requests/return-submit', { id: r1.id, declared_qty: 19 }, stu);
  ok(over2.status === 400, '申报数量超过实发被拒绝');
  const otherPeople = await call('POST', '/api/requests/return-submit', { id: r1.id, declared_qty: 18, photos: ['a.jpg'] }, stu2);
  ok(otherPeople.status === 400, '替他人归还被拒绝');

  const avail4 = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id).available;
  const submit = await call('POST', '/api/requests/return-submit', {
    id: r1.id, declared_qty: 16, photos: ['归还现场1.jpg', '归还现场2.jpg'],
  }, stu);
  eq(submit.data.status, 'return_submitted', '学生提交归还 → 待老师清点');
  eq(submit.data.return_declared_qty, 16, '申报归还 16');
  const avail5 = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id).available;
  eq(avail5, avail4, '提交归还申请时库存不变（实还数量尚未确认）');
  const dup = await call('POST', '/api/requests/return-submit', { id: r1.id, declared_qty: 16, photos: ['a.jpg'] }, stu);
  ok(dup.status === 400, '重复提交归还被拒绝');

  const wrongWh = await call('POST', '/api/requests/return', { id: r1.id, returned_qty: 16 }, whOther);
  ok(wrongWh.status === 400, '非负责老师清点被拦截：' + wrongWh.data.error);
  const whTodo = await call('GET', '/api/requests', undefined, wh);
  ok(whTodo.data.some(x => x.id === r1.id && x.status === 'return_submitted'), '待清点单据出现在负责老师待办');
  const whOtherTodo = await call('GET', '/api/requests', undefined, whOther);
  ok(!whOtherTodo.data.some(x => x.id === r1.id), '其他老师看不到该待清点单据');

  const ret = await call('POST', '/api/requests/return', { id: r1.id, returned_qty: 15 }, wh);
  eq(ret.data.status, 'mismatch', '申报 16 实还 15 → 账实不符');
  eq(ret.data.missing_qty, 3, '缺失 18-15=3（以实发为基准）');
  const avail6 = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id).available;
  eq(avail6, avail4 + 15, `库存只回增实还 15：${avail4} → ${avail6}（缺失 3 不回增）`);
  const twice = await call('POST', '/api/requests/return', { id: r1.id, returned_qty: 15 }, wh);
  ok(twice.status === 400, '重复归还被拒绝');

  // ---------- 7. 账实相符与核销 ----------
  console.log('\n[7] 账实相符 + 资产管理员核销');
  const c3 = await call('POST', '/api/requests', { material_id: target.id, apply_qty: 5, purpose: '全额归还验证' }, stu);
  await call('POST', '/api/requests/mentor', { id: c3.data.id, pass: true }, mentor);
  await call('POST', '/api/requests/check', { id: c3.data.id, approved_qty: 5 }, wh);
  await call('POST', '/api/requests/issue', { id: c3.data.id, issued_qty: 5 }, wh);
  const avail7 = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id).available;
  await call('POST', '/api/requests/return-submit', { id: c3.data.id, declared_qty: 5, photos: ['ok.jpg'] }, stu);
  const ret2 = await call('POST', '/api/requests/return', { id: c3.data.id, returned_qty: 5 }, wh);
  eq(ret2.data.status, 'returned', '全额归还 → 已归还');
  eq(ret2.data.missing_qty, 0, '缺失为 0');
  const avail8 = (await call('GET', '/api/materials', undefined, stu)).data.find(m => m.id === target.id).available;
  eq(avail8, avail7 + 5, `全额归还库存回增 5：${avail7} → ${avail8}`);

  const mmList = await call('GET', '/api/requests', undefined, adm);
  ok(mmList.data.some(x => x.id === r1.id && x.status === 'mismatch'), '资产管理员看到账实不符单据');
  const staffApi = await call('GET', '/api/warehouse/staff', undefined, adm);
  ok(Array.isArray(staffApi.data) && staffApi.data.length > 0, '资产管理员可读取仓库老师名单');
  const staffDenied = await call('GET', '/api/warehouse/staff', undefined, wh);
  ok(staffDenied.status === 400, '普通仓库老师不可读取老师名单');
  const close = await call('POST', '/api/requests/close', { id: r1.id, note: '已按丢失流程处理' }, adm);
  eq(close.data.status, 'closed', '核销 → 已核销');
  const closeAgain = await call('POST', '/api/requests/close', { id: r1.id, note: 'x' }, adm);
  ok(closeAgain.status === 400, '重复核销被拒绝');
  const closeDenied = await call('POST', '/api/requests/close', { id: c3.data.id, note: 'x' }, stu);
  ok(closeDenied.status === 400, '学生不可核销');

  // ---------- 8. 改绑负责人 ----------
  console.log('\n[8] 资产管理员改绑物资负责人');
  const assignDenied = await call('POST', '/api/materials', { id: target.id, owner_id: whOtherId(1) }, stu);
  ok(assignDenied.status === 400, '学生不可改绑负责人');
  const others = await call('GET', '/api/warehouse/staff', undefined, adm);
  const newOwner = others.data.find(s => s.name !== '车队楼张师傅');
  const assign = await call('POST', '/api/materials', { id: target.id, owner_id: newOwner.id }, adm);
  eq(assign.data.owner_name, newOwner.name, '负责人改绑立即生效');
  const newOwnerMats = await call('GET', '/api/materials', undefined, newOwner.username === 'wh006' ? wh : await login(newOwner.username));
  ok(newOwnerMats.data.some(m => m.id === target.id), '新负责人能看到该物资');
  await call('POST', '/api/materials', { id: target.id, owner_id: assign.data.owner_id }, adm); // 改回

  // ---------- 9. 详情页数据 ----------
  console.log('\n[9] 详情独立页数据');
  const det = await call('GET', '/api/requests/' + r1.id, undefined, stu);
  ok(det.status === 200, '学生可查看自己单据详情');
  ok(Array.isArray(det.data.logs) && det.data.logs.length >= 5,
    `流转记录 ${det.data.logs.length} 条（申领→审批→核定→发放→归还→核销）`);
  ok(Array.isArray(det.data.stock_logs) && det.data.stock_logs.length >= 2,
    `库存流水 ${det.data.stock_logs.length} 条`);
  const bizTypes = det.data.stock_logs.map(l => l.biz_type);
  ok(bizTypes.includes('issue') && bizTypes.includes('return'), '流水含发放与归还');
  ok(det.data.stock_logs.every(l => typeof l.before_qty === 'number' && typeof l.after_qty === 'number'),
    '流水含变动前/后数量');
  eq(det.data.apply_qty, 20, '详情含申请数量');
  eq(det.data.approved_qty, 20, '详情含核定数量');
  eq(det.data.issued_qty, 18, '详情含实发数量');
  eq(det.data.return_declared_qty, 16, '详情含申报归还');
  eq(det.data.returned_qty, 15, '详情含实还');
  eq(det.data.missing_qty, 3, '详情含缺失数量');
  const detOther = await call('GET', '/api/requests/' + r1.id, undefined, stu2);
  ok(detOther.status === 400, '其他学生不可查看该单据详情');
  const detWh = await call('GET', '/api/requests/' + r1.id, undefined, whOther);
  ok(detWh.status === 400, '非负责老师不可查看该单据详情');

  // ---------- 10. 越权与边界 ----------
  console.log('\n[10] 越权与边界');
  const stuCheck = await call('POST', '/api/requests/check', { id: r1.id, approved_qty: 1 }, stu);
  ok(stuCheck.status === 400, '学生不可核定');
  const mentorIssue = await call('POST', '/api/requests/issue', { id: c3.data.id, issued_qty: 1 }, mentor);
  ok(mentorIssue.status === 400, '导师不可发放');
  const noSuch = await call('GET', '/api/requests/99999', undefined, adm);
  ok(noSuch.status === 400, '不存在的单据返回错误');
  const unimpl = await call('GET', '/api/assets', undefined, adm);
  eq(unimpl.status, 404, '固定资产接口已下线（404）');

  // ---------- 11. 持久化 ----------
  console.log('\n[11] 状态持久化（刷新后不丢）');
  ok(!!store['zz_demo_state_v1'], '状态已写入 localStorage');
  const saved = JSON.parse(store['zz_demo_state_v1']);
  ok(saved.requests.length >= 4, `持久化了 ${saved.requests.length} 张单据`);
  ok(saved.stock.length > 0, `持久化了 ${saved.stock.length} 条库存流水`);
  ok(typeof sandbox.DEMO.reset === 'function', '提供 DEMO.reset() 重置入口');

  console.log('\n' + (fails === 0 ? '静态演示版业务回归全部通过 ✅' : fails + ' 项失败 ❌'));
  process.exit(fails === 0 ? 0 : 1);

  function whOtherId() { return 1; }
})().catch(e => { console.error('执行异常：', e); process.exit(1); });