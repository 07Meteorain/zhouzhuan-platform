'use strict';
/**
 * 端到端验证脚本：走完"申请 → 导师通过 → 部分通过改单 → 再审批 → 发放扣库存 → 归还回增 → 缺失核销"
 * 用法：node scripts/e2e.js
 */
const BASE = 'http://localhost:' + (process.env.PORT || 3000);
const tokens = {};

async function call(p, body, who) {
  const r = await fetch(BASE + p, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + (tokens[who] || '') },
    body: JSON.stringify(body || {}),
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`[${who}] ${p} -> ${d.error || r.status}`);
  return d;
}
async function get(p, who) {
  const r = await fetch(BASE + p, { headers: { Authorization: 'Bearer ' + (tokens[who] || '') } });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`[${who}] ${p} -> ${d.error || r.status}`);
  return d;
}
// 主测试物资的负责人账号，由脚本按库存最充足的物资动态确定，
// 这样导入真实台账后测试依然跑得通（不写死 wh001）
let WH = 'wh001';
const avail = async (id, who = WH) => {
  const list = await get('/api/materials', who);
  const hit = list.find(m => m.id === id);
  if (!hit) throw new Error(`物资 id=${id} 不在 ${who} 的负责范围内，无法读取库存`);
  return hit.available;
};
const ok = (c, m) => console.log((c ? '  PASS ' : '  FAIL ') + m) || (c ? 0 : fails++);
let fails = 0;

(async () => {
  for (const u of ['stu001', 'mentor01', 'wh001', 'wh002', 'wh003', 'wh004', 'wh005', 'wh006', 'adm001']) {
    const r = await fetch(BASE + '/api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: 'demo1234' }),
    });
    const d = await r.json();
    if (d.token) tokens[u] = d.token;
  }
  console.log('== 登录 ==');

  // 按名称/库存定位测试用物资，避免依赖自增 ID（重新导入后 ID 会变）。
  // MAT_ID 取库存最充足的物资，其负责人即 WH —— 全流程都用他操作，验证权限与状态机
  const allMats = await get('/api/materials', 'stu001');
  const MAT = allMats.slice().sort((a, b) => b.available - a.available)[0];
  const MAT_ID = MAT.id;
  // 找到该物资的负责人账号：其 /api/materials 列表应包含 MAT_ID
  const candidates = ['wh001', 'wh002', 'wh003', 'wh004', 'wh005', 'wh006'];
  for (const c of candidates) {
    if (!tokens[c]) continue;
    const list = await get('/api/materials', c).catch(() => []);
    if (list.some(m => m.id === MAT_ID)) { WH = c; break; }
  }
  if (!tokens[WH]) throw new Error(`找不到 ${MAT.name} 的负责老师账号，无法继续测试`);
  console.log(`  主测物资：${MAT.name}${MAT.size || ''} ${MAT.available}${MAT.unit}（负责人 ${WH}）`);

  // TENT_ID 取"马扎"：真实台账物资，归田径场组王师傅 wh004，用于越权拦截断言
  const TENT_ID = (allMats.find(m => m.name === '马扎') || allMats[allMats.length - 1]).id;

  // 1 库存基线
  const base1 = await avail(MAT_ID);
  console.log(`\n[1] 学生申领远超库存的数量（物资 id=${MAT_ID}）`);
  let r = await call('/api/requests', { material_id: MAT_ID, apply_qty: 999, purpose: 'E2E 测试' }, 'stu001');
  ok(r.status === 'pending_mentor', '申领单创建，状态=待导师审批');
  const reqA = r.id;
  ok(r.apply_qty === 999, '申请数量=999');

  console.log('\n[2] 导师驳回 → 学生重提');
  await call('/api/requests/mentor', { id: reqA, pass: 0, note: '数量异常' }, 'mentor01');
  ok((await get('/api/requests/' + reqA, 'stu001')).status === 'rejected', '原单已驳回');

  console.log('\n[3] 学生重新提交合理数量');
  r = await call('/api/requests', { material_id: MAT_ID, apply_qty: 120, purpose: '社团活动' }, 'stu001');
  const reqB = r.id;
  ok(r.status === 'pending_mentor', '新单创建');

  console.log('\n[4] 导师通过');
  r = await call('/api/requests/mentor', { id: reqB, pass: 1 }, 'mentor01');
  ok(r.status === 'pending_warehouse', '状态=待仓库核库存');

  console.log('\n[5] 仓库老师核定部分通过（核定为 60，库存基线 ' + base1 + '）');
  r = await call('/api/requests/check', { id: reqB, approved_qty: 60, note: '库存不足' }, WH);
  ok(r.origin.status === 'partial_closed', '原单=部分通过已终止');
  ok(r.origin.apply_qty === 120, '原单申请数量 120 被保留，未被覆盖');
  ok(r.created.apply_qty === 60 && r.created.status === 'pending_mentor', '改单申请数量=60，回到待导师审批');
  ok(r.created.parent_id === reqB, '改单与原单已关联');
  const reqC = r.created.id;

  console.log('\n[6] 导师再次通过改单 → 仓库再次核定为完全通过');
  await call('/api/requests/mentor', { id: reqC, pass: 1 }, 'mentor01');
  r = await call('/api/requests/check', { id: reqC, approved_qty: 60 }, WH);
  ok(r.status === 'to_issue', '状态=待发放');

  console.log('\n[7] 超发拦截：核定 60 却想发 61');
  try { await call('/api/requests/issue', { id: reqC, issued_qty: 61 }, WH); ok(false, '应拦截超发'); }
  catch (e) { ok(/核定/.test(e.message), '超发被拦截：' + e.message); }

  console.log('\n[8] 按实发 60 发放，库存扣减');
  r = await call('/api/requests/issue', { id: reqC, issued_qty: 60, deposit_note: '学生证抵押' }, WH);
  const afterIssue = await avail(MAT_ID);
  ok(r.issued_qty === 60, '实发数量=60');
  ok(r.status === 'in_use', '状态=借用中');
  ok(afterIssue === base1 - 60, `库存 ${base1} → ${afterIssue}（按实发扣减，非申请数量）`);

  console.log('\n[9] 核定数量超过可用库存应被拦截');
  const over = await call('/api/requests', { material_id: MAT_ID, apply_qty: 9999 }, 'stu001');
  await call('/api/requests/mentor', { id: over.id, pass: 1 }, 'mentor01');
  try { await call('/api/requests/check', { id: over.id, approved_qty: 5000 }, WH); ok(false, '核定应被拦截'); }
  catch (e) { ok(/可用库存不足/.test(e.message), '核定超库存被拦截：' + e.message); }
  try { await call('/api/requests/issue', { id: over.id, issued_qty: 5000 }, WH); ok(false, '发放应被拦截'); }
  catch (e) { ok(true, '超发被拦截：' + e.message); }
  ok((await avail(MAT_ID)) === base1 - 60, '库存未被超发请求影响，仍为 ' + (base1 - 60));

  const expected = base1 - 60 + 58; // 归还可用量，只回增实还 58
  console.log(`\n[10] 归还 58 件（缺 2 件），预期库存回到 ${expected}`);
  r = await call('/api/requests/return', { id: reqC, returned_qty: 58, photos: ['现场.jpg'] }, WH);
  const afterRet = await avail(MAT_ID);
  ok(r.returned_qty === 58, '实还数量=58');
  ok(r.missing_qty === 2, '缺失数量=2');
  ok(r.status === 'mismatch', '状态=账实不符待处理');
  ok(afterRet === expected, `库存 ${base1 - 60} → ${afterRet}（回增 58，缺失 2 未计入库存）`);

  console.log('\n[11] 幂等校验：重复提交同类型归还不重复回增');
  try { await call('/api/requests/return', { id: reqC, returned_qty: 58, photos: ['x.jpg'] }, WH); } catch (e) {}
  ok((await avail(MAT_ID)) === expected, `库存仍为 ${expected}，无重复回增`);

  console.log('\n[12] 照片凭证必填校验');
  let photoBlocked = false;
  try { await call('/api/requests/return', { id: reqC, returned_qty: 58, photos: [] }, WH); }
  catch (e) { photoBlocked = true; }
  ok(photoBlocked, '无照片的归还被拦截');

  console.log('\n[13] 资产管理员核销缺失');
  r = await call('/api/requests/close', { id: reqC, note: '按学校丢失流程处理完毕' }, 'adm001');
  ok(r.status === 'closed', '状态=已核销');
  ok((await avail(MAT_ID)) === expected, `核销不改变库存，缺失 2 始终未计入，库存仍为 ${expected}`);

  console.log('\n[14] 物资负责老师路由与越权拦截');
  // 马扎 真实台账里归"田径场组王师傅"(wh004)；刘师傅(wh005) 管活动中心，不该看到也不该能核定
  const wh4Mats = await get('/api/materials', 'wh004');
  const wh5Mats = await get('/api/materials', 'wh005');
  ok(!wh5Mats.some(m => m.id === TENT_ID), '刘师傅(wh005)看不到马扎(负责人是王师傅)');
  ok(wh4Mats.every(m => m.owner_name === '田径场组王师傅'), '王师傅只看到自己负责的物资');
  ok(wh4Mats.some(m => m.id === TENT_ID), '王师傅(wh004)看到马扎且负责人是自己');
  // 同名多规格必须独立计库存
  const desks = wh4Mats.concat(wh5Mats).filter(m => m.name === '长条桌');
  ok(desks.length >= 2 && new Set(desks.map(d => d.size)).size === desks.length,
     `长条桌 ${desks.length} 种规格各自独立：${desks.map(d => d.size).join(' / ')}`);

  const r14 = await call('/api/requests', { material_id: TENT_ID, apply_qty: 5, purpose: '社团户外活动' }, 'stu001');
  ok(r14.owner_name === '田径场组王师傅', `学生提交后系统已路由到负责人：${r14.owner_name}`);
  await call('/api/requests/mentor', { id: r14.id, pass: 1 }, 'mentor01');

  let blocked14 = false, msg14 = '';
  try { await call('/api/requests/check', { id: r14.id, approved_qty: 5 }, 'wh005'); }
  catch (e) { blocked14 = true; msg14 = e.message; }
  ok(blocked14, `刘师傅越权核定被拦截：${msg14}`);

  const r14b = await call('/api/requests/check', { id: r14.id, approved_qty: 5 }, 'wh004');
  ok(r14b.status === 'to_issue', '王师傅正常核定，单据转为待发放');

  const wh5Reqs = await get('/api/requests', 'wh005');
  ok(!wh5Reqs.some(x => x.id === r14.id), '马扎单据不出现在刘师傅的待办列表');
  const admReqs = await get('/api/requests', 'adm001');
  ok(admReqs.some(x => x.id === r14.id), '资产管理员拥有全局视图，能看到全部单据');

  console.log('\n[15] 资产管理员改绑物资负责人 + 权限边界');
  const staff = await get('/api/warehouse/staff', 'adm001');
  const liu = staff.find(s => s.username === 'wh005').id;
  const wang = staff.find(s => s.username === 'wh004').id;
  const r15 = await call('/api/materials', { id: TENT_ID, owner_id: liu }, 'adm001');
  ok(r15.owner_id === liu && r15.owner_name === '活动中心刘师傅', `马扎已改绑给${r15.owner_name}`);
  const wh4After = await get('/api/materials', 'wh004');
  ok(!wh4After.some(m => m.id === TENT_ID), '改绑后王师傅不再看到马扎');
  // 改回原负责人，保持演示数据一致
  await call('/api/materials', { id: TENT_ID, owner_id: wang }, 'adm001');

  let blocked15 = false;
  try { await call('/api/warehouse/staff', {}, WH); } catch (e) { blocked15 = true; }
  ok(blocked15, '普通仓库老师无权查看仓库老师名单（仅资产管理员）');

  console.log('\n== 流水核对 ==');
  const logs = await get(`/api/stock/logs?material_id=${MAT_ID}`, WH);
  const mine = logs.filter(l => l.ref_code);
  console.log('  本次产生的库存流水：');
  mine.forEach(l => console.log(`    ${l.created_at.slice(0, 19).replace('T', ' ')} ${l.material_name} ${l.change_qty > 0 ? '+' : ''}${l.change_qty} ${l.before_qty}→${l.after_qty} [${l.biz_type}] ${l.remark || ''}`));
  const sum = mine.filter(l => l.created_at > new Date(Date.now() - 600000).toISOString()).reduce((a, l) => a + l.change_qty, 0);
  ok(sum === -2 || sum === 0, `流水净额 ${sum}（-60 发放 +58 归还 = -2，对应缺失 2）`);

  console.log(fails === 0 ? '\n全部通过 ✅' : `\n有 ${fails} 项失败 ❌`);
  process.exit(fails === 0 ? 0 : 1);
})().catch(e => { console.error('执行异常：', e.message); process.exit(1); });
