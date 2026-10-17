'use strict';
/**
 * 归还流程专项验证
 *
 * 覆盖真实业务链路：
 *   学生申领 → 导师通过 → 老师核定 → 老师发放（学生证抵押）
 *   → 学生拍照提交归还申请（库存不动）
 *   → 负责老师清点登记实还数量（此时才回增库存）
 *   → 账实相符=已归还 / 账实不符=转丢失流程 → 资产处核销
 *
 * 重点校验：
 *   · 学生提交归还申请时库存不能变（实还数量尚未确认）
 *   · 单据必须出现在该物资负责老师的待清点列表里，其他老师看不到
 *   · 老师清点的实还数量优先于学生申报数量
 *   · 缺失数量只标记，不计入库存
 *   · 学生不能替别人归还，也不能重复提交
 */
const BASE = 'http://localhost:' + (process.env.PORT || 3000);
let TOKEN = '';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

// who 可以是登录名（stu001/wh005…），也可以是已取好的 token 字符串
async function call(p, body, who) {
  const tk = who ? (who.startsWith('tok-') ? who.slice(4) : await tokenOf(who)) : TOKEN;
  const r = await fetch(BASE + p, {
    method: body === null ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tk },
    body: body === null ? undefined : JSON.stringify(body),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${p} -> ${d.error || ('HTTP ' + r.status)}`);
  return d;
}
// 传 username 时自动换取 token；也可以直接传已取好的 token
const cache = {};
async function tokenOf(username) {
  if (cache[username]) return cache[username];
  const d = await call('/api/login', { username, password: 'demo1234' });
  cache[username] = d.token;
  return d.token;
}


const invOf = async (who, id) => (await call('/api/materials', null, who)).find(m => m.id === id);

(async () => {
  console.log('== 登录 ==');
  const stu = 'tok-' + await tokenOf('stu001');
  const stu2 = 'tok-' + await tokenOf('stu002');
  const mentor = 'tok-' + await tokenOf('mentor01');
  // 自动挑一个负责老师：谁的物资最多用谁的
  let WH = 'wh001', MAT = null;
  for (const u of ['wh004', 'wh005', 'wh006']) {
    const ms = await call('/api/materials', null, u);
    if (ms.length && (!MAT || ms[0].available > MAT.available)) { WH = u; MAT = ms[0]; }
  }
  console.log(`  主测物资：${MAT.name} ${MAT.size || ''} ${MAT.available}${MAT.unit}（负责人 ${WH}）`);

  const ISSUE = 10;

  // ---------- 走到借用中 ----------
  console.log('\n[1] 申领→审批→核定→发放');
  let r = await call('/api/requests', {
    material_id: MAT.id, apply_qty: ISSUE, purpose: '归还流程测试',
    use_start: '2026-10-14', use_end: '2026-10-20',
    borrower: '张同学', phone: '13800000001', deposit_note: '学生证抵押',
  }, stu);
  const ID = r.id;
  await call('/api/requests/mentor', { id: ID, pass: 1, note: '同意' }, mentor);
  await call('/api/requests/check', { id: ID, approved_qty: ISSUE }, WH);
  await call('/api/requests/issue', { id: ID, issued_qty: ISSUE, deposit_note: '学生证抵押' }, WH);
  const afterIssue = await invOf(WH, MAT.id);
  ok(afterIssue.available === MAT.available - ISSUE,
    `发放 ${ISSUE}${MAT.unit}，库存 ${MAT.available} → ${afterIssue.available}`);

  // ---------- 学生提交归还申请 ----------
  console.log('\n[2] 学生拍照提交归还申请');
  const beforeSubmit = await invOf(WH, MAT.id);
  r = await call('/api/requests/return-submit', {
    id: ID, declared_qty: ISSUE, photos: ['归还现场1.jpg', '归还现场2.jpg'],
  }, stu);
  ok(r.status === 'return_submitted', `单据状态 → ${r.status}（待老师清点）`);
  ok(r.return_declared_qty === ISSUE, `学生申报归还 ${r.return_declared_qty}${MAT.unit}`);
  const afterSubmit = await invOf(WH, MAT.id);
  ok(afterSubmit.available === beforeSubmit.available,
    `提交申请后库存未变（${afterSubmit.available}），实还数量待老师清点才回增`);

  console.log('\n[3] 归还申请的校验与权限');
  const expectFail = async (fn, why) => {
    try { await fn(); ok(false, why + '（但竟然成功了）'); }
    catch (e) { ok(true, `${why} → 被拦截：${e.message}`); }
  };
  await expectFail(() => call('/api/requests/return-submit', { id: ID, declared_qty: ISSUE, photos: [] }, stu),
    '无照片的归还申请');
  await expectFail(() => call('/api/requests/return-submit', { id: ID, declared_qty: ISSUE + 1, photos: ['a.jpg'] }, stu),
    '申报归还数超过实发数');
  await expectFail(() => call('/api/requests/return-submit', {
    id: ID, declared_qty: ISSUE, photos: ['a.jpg'],
  }, stu2), '学生替别人归还');
  await expectFail(() => call('/api/requests/return-submit', { id: ID, declared_qty: 1, photos: ['a.jpg'] }, stu),
    '重复提交归还申请');
  await expectFail(() => call('/api/requests/return', { id: ID, returned_qty: ISSUE }, mentor),
    '导师无权清点登记');

  // ---------- 老师侧待清点 ----------
  console.log('\n[4] 待清点单据路由到该物资负责老师');
  const whReqs = await call('/api/requests', null, WH);
  const mine = whReqs.find(x => x.id === ID);
  ok(!!mine, `${WH} 的待办里能看到待清点单据`);
  ok(mine && mine.status === 'return_submitted', `状态=${mine && mine.status_text}`);
  ok(mine && JSON.parse(mine.return_photos || '[]').length === 2,
    `老师能看到学生上传的 ${mine ? JSON.parse(mine.return_photos || '[]').length : 0} 张照片`);
  for (const other of ['wh004', 'wh005', 'wh006'].filter(u => u !== WH)) {
    const o = await call('/api/requests', null, other);
    ok(!o.some(x => x.id === ID), `其他老师 ${other} 看不到此单`);
  }
  await expectFail(() => call('/api/requests/return', { id: ID, returned_qty: ISSUE },
    ['wh004', 'wh005', 'wh006'].find(u => u !== WH)), '非负责老师清点登记');

  // ---------- 老师清点：申报60 实还58 的场景 ----------
  console.log('\n[5] 老师清点：申报 8 实还 6（差额进丢失流程）');
  const declared = ISSUE - 2;
  const actual = ISSUE - 4;
  await call('/api/requests/return-submit', {
    id: ID, declared_qty: ISSUE, photos: ['归还现场1.jpg'],
  }, stu).catch(() => {}); // 已提交过会失败，改用新单验证申报≠实还

  // 当前单已被占，换一张新单走"申报≠实还"场景
  const r2 = await call('/api/requests', {
    material_id: MAT.id, apply_qty: ISSUE, purpose: '申报与实还不一致',
    borrower: '张同学', phone: '13800000001',
  }, stu);
  await call('/api/requests/mentor', { id: r2.id, pass: 1 }, mentor);
  await call('/api/requests/check', { id: r2.id, approved_qty: ISSUE }, WH);
  await call('/api/requests/issue', { id: r2.id, issued_qty: ISSUE }, WH);
  await call('/api/requests/return-submit', { id: r2.id, declared_qty: declared, photos: ['p.jpg'] }, stu);
  r = await call('/api/requests/return', { id: r2.id, returned_qty: actual }, WH);
  ok(r.returned_qty === actual, `老师清点实还 ${r.returned_qty}${MAT.unit}（学生申报 ${declared}）`);
  ok(r.missing_qty === ISSUE - actual, `缺失 ${r.missing_qty}${MAT.unit}，仅标记不计入库存`);
  ok(r.status === 'mismatch', `状态 → ${r.status}（账实不符待处理）`);
  const inv2 = await invOf(WH, MAT.id);
  const expectAvail = afterSubmit.available - ISSUE + actual;
  ok(inv2.available === expectAvail,
    `库存 ${afterSubmit.available} - ${ISSUE} + ${actual} = ${inv2.available}（只回增实还，缺失不回增）`);

  const detail = await call(`/api/requests/${r2.id}`, null, WH);
  const drift = (detail.logs || []).some(l => /申报 8.*实清点 6|申报 \d+.*实清点/.test(l.action));
  ok(drift, '流转记录中留痕「学生申报 vs 实际清点」差异');

  console.log('\n[6] 账实相符 → 已归还');
  const r3 = await call('/api/requests', {
    material_id: MAT.id, apply_qty: 5, purpose: '账实相符', borrower: '张同学',
  }, stu);
  await call('/api/requests/mentor', { id: r3.id, pass: 1 }, mentor);
  await call('/api/requests/check', { id: r3.id, approved_qty: 5 }, WH);
  await call('/api/requests/issue', { id: r3.id, issued_qty: 5 }, WH);
  await call('/api/requests/return-submit', { id: r3.id, declared_qty: 5, photos: ['ok.jpg'] }, stu);
  r = await call('/api/requests/return', { id: r3.id, returned_qty: 5 }, WH);
  ok(r.status === 'returned', `全额归还 → ${r.status}（已归还）`);
  ok(r.missing_qty === 0, '缺失数量 0');

  console.log('\n[7] 老师可直接清点（学生未线上提交）');
  const r4 = await call('/api/requests', {
    material_id: MAT.id, apply_qty: 4, purpose: '现场直接归还', borrower: '李同学',
  }, stu);
  await call('/api/requests/mentor', { id: r4.id, pass: 1 }, mentor);
  await call('/api/requests/check', { id: r4.id, approved_qty: 4 }, WH);
  await call('/api/requests/issue', { id: r4.id, issued_qty: 4 }, WH);
  await expectFail(() => call('/api/requests/return', { id: r4.id, returned_qty: 4 }, WH),
    '无照片凭证的归还登记');
  r = await call('/api/requests/return', { id: r4.id, returned_qty: 4, photos: ['老师补拍.jpg'] }, WH);
  ok(r.status === 'returned', '学生未提交申请时老师可补拍照片直接登记（线下归还场景）');
  await expectFail(() => call('/api/requests/return', { id: r4.id, returned_qty: 1, photos: ['a.jpg'] }, WH), '已归还单据重复归还');
  await expectFail(() => call('/api/requests/return', { id: r4.id, returned_qty: 99, photos: ['a.jpg'] }, WH), '实还超过实发');

  console.log('\n[8] 学生侧可见性');
  const stuReqs = await call('/api/requests', null, 'stu001');
  ok(stuReqs.some(x => x.id === ID), '学生能看到自己借用中的单据');
  ok(stuReqs.some(x => x.status === 'returned'), '学生能看到已归还记录');
  const stu2Reqs = await call('/api/requests', null, 'stu002');
  ok(!stu2Reqs.some(x => x.id === ID), '其他学生看不到该单据');

  console.log(fails === 0 ? '\n归还流程全部通过 ✅' : `\n有 ${fails} 项失败 ❌`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('执行异常：', e.message); process.exit(1); });
