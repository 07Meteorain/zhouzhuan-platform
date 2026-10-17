'use strict';
/**
 * 并发压测：N 个学生同时抢同一批物资，验证库存不为负、不超卖
 * 用法：
 *   node scripts/stress.js [并发数] [每人申领数量]
 * 不传每人数量时，按"总需求 = 库存的 3 倍"自动计算，确保能触发库存不足的拒绝分支
 */
const BASE = 'http://localhost:' + (process.env.PORT || 3000);
const CONC = Number(process.argv[2] || 50);
const EACH_ARG = Number(process.argv[3] || 0);
let EACH = EACH_ARG;

async function login(u) {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: u, password: 'demo1234' }),
  });
  return (await r.json()).token;
}
const post = (p, body, tok) => fetch(BASE + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tok },
  body: JSON.stringify(body),
}).then(async (r) => ({ status: r.status, d: await r.json().catch(() => ({})) }));

(async () => {
  const stu = await login('stu001');
  const ment = await login('mentor01');

  // 选一种库存充足的物资做极限测试，并找到它的负责老师来操作核定
  // （不写死 wh001 —— 导入真实台账后每位老师名下的物资不同）
  const allMats = await fetch(BASE + '/api/materials', { headers: { Authorization: 'Bearer ' + stu } })
    .then(r => r.json());
  const MID_TARGET = allMats.slice().sort((a, b) => b.available - a.available)[0];
  if (!MID_TARGET) { console.error('库中没有物资，无法压测'); process.exit(1); }

  let wh = null;
  for (const u of ['wh001', 'wh002', 'wh003', 'wh004', 'wh005', 'wh006']) {
    const t = await login(u).catch(() => null);
    if (!t) continue;
    const list = await fetch(BASE + '/api/materials', { headers: { Authorization: 'Bearer ' + t } }).then(r => r.json());
    if (Array.isArray(list) && list.some(m => m.id === MID_TARGET.id)) { wh = t; break; }
  }
  if (!wh) { console.error(`找不到 ${MID_TARGET.name} 的负责老师，无法压测`); process.exit(1); }

  const before = MID_TARGET;
  // 未指定每人数量时，按库存的 3 倍摊到并发数上，保证能压出"库存不足被拒"的分支
  if (!EACH_ARG) EACH = Math.max(1, Math.ceil((before.available * 3) / CONC));
  console.log(`目标物资：${before.name}${before.size ? '（' + before.size + '）' : ''}，当前可用 ${before.available} ${before.unit}`);
  console.log(`并发：${CONC} 个申领，每人 ${EACH}，总计需求 ${CONC * EACH}\n`);

  const results = { ok: 0, denied: 0, other: 0 };
  const codes = [];

  await Promise.all(
    Array.from({ length: CONC }, async () => {
      // 每单走完 申领→导师通过→仓库核定
      const c = await post('/api/requests', { material_id: MID_TARGET.id, apply_qty: EACH }, stu);
      if (c.status !== 200) { results.other++; return; }
      await post('/api/requests/mentor', { id: c.d.id, pass: 1 }, ment);
      const k = await post('/api/requests/check', { id: c.d.id, approved_qty: EACH }, wh);
      if (k.status === 200) {
        results.ok++;
        codes.push(c.d.code);
        // 立即发放，制造真实并发写库存
        await post('/api/requests/issue', { id: c.d.id, issued_qty: EACH }, wh);
      } else if (k.status === 400) {
        results.denied++;
      } else results.other++;
    })
  );

  const after = (await fetch(BASE + '/api/materials', { headers: { Authorization: 'Bearer ' + wh } }).then(r => r.json()))
    .find(m => m.id === MID_TARGET.id);
  if (!after) { console.error('压测后读不到该物资库存'); process.exit(1); }

  console.log(`核定成功 ${results.ok}  库存不足被拒 ${results.denied}  其他 ${results.other}`);
  console.log(`库存 ${before.available} → ${after.available}`);
  console.log(`实际发放 ${before.available - after.available}`);

  const neg = after.available < 0;
  const over = before.available - after.available > before.available;
  console.log(`\n库存为负：${neg ? '是（错误）' : '否'}`);
  console.log(`超卖：${over ? '是（错误）' : '否'}`);
  console.log(results.denied > 0 ? '并发拦截生效：超出可用量的申领被正确拒绝' : '并发拦截：全部通过（库存充足）');
  console.log(!neg && !over ? '\n压测通过 ✅' : '\n压测失败 ❌');
  process.exit(!neg && !over ? 0 : 1);
})();
