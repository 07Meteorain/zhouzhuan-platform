'use strict';
/**
 * 学生端渲染验证：不依赖浏览器，直接调用页面里的渲染函数，
 * 确认下拉框 option 与负责人提示能被正确生成（回归防空下拉框）
 */
const fs = require('node:fs');
const path = require('node:path');

const BASE = 'http://localhost:' + (process.env.PORT || 3000);
let TOKEN = '';
let fails = 0;
const ok = (c, m) => { console.log((c ? '  PASS ' : '  FAIL ') + m); if (!c) fails++; };

async function api(p, opt) {
  const r = await fetch(BASE + p, Object.assign({
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN },
  }, opt || {}));
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
  return d;
}

// 把 index.html 里的 <script> 抽出来，在沙箱里执行，拿到 studentView 等函数
function loadPageFunctions() {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const js = html.match(/<script>([\s\S]*?)<\/script>/)[1]
    // 去掉末尾的 boot() 自动调用，避免依赖 DOM
    .replace(/\bboot\(\);\s*$/, '');
  const ctx = {};
  // eslint-disable-next-line no-new-func
  const fn = new Function('window', 'document', 'localStorage', 'fetch', 'alert',
    js + '\nreturn { studentView, warehouseView, adminView, render, esc, tag, applyPage, myReqPage, matListPage, returnBox, setStuTab, detailPage, detailBack };');
  return fn(
    { location: { reload() {} } },
    { getElementById: () => null, addEventListener() {}, querySelector: () => null },
    { getItem: () => '', setItem() {}, removeItem() {} },
    global.fetch,
    () => {}
  );
}

(async () => {
  const r = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'stu001', password: 'demo1234' }),
  });
  TOKEN = (await r.json()).token;

  const mats = await api('/api/materials');
  ok(mats.length === 18, `接口返回 ${mats.length} 种物资`);

  const F = loadPageFunctions();
  console.log('\n[1] 学生端页签：可申领物资在最前，新建申领独立成页');
  // 默认页签是"可申领物资"，且「新建申领」表单单独成页
  const shell0 = F.studentView([], mats);   // 先初始化 ALL_MATS
  const applyHtml = F.applyPage();          // 再取申领页
  ok(/新建申领单/.test(applyHtml), '「新建申领」是独立页面');
  // 页签顺序：可申领物资必须是第一个
  const shell = shell0;
  const tabOrder = (shell.match(/setStuTab\('([a-z]+)'\)/g) || []).map(x => x.match(/'([a-z]+)'/)[1]);
  ok(tabOrder[0] === 'list', `第一个页签是「可申领物资」（实际：${tabOrder.join(' → ')}）`);
  ok(/class="mcard"/.test(shell), '默认落地页就是物资卡片墙');
  ok(!/可申领物资（/.test(applyHtml), '申领页内不再混排物资资料列表');
  ok((applyHtml.match(/class="mcard"/g) || []).length === 0, '申领页内没有物资卡片');
  ok(!/我的借用与归还/.test(applyHtml), '归还内容不在申领页内直接展开');

  const optCount = (applyHtml.match(/<option value="/g) || []).length;
  ok(optCount === mats.length, `申领页下拉框含 ${optCount} 个 option（应等于物资种类 ${mats.length}）`);
  ok(!/无可申领物资/.test(applyHtml), '未误报"无可申领物资"');

  const first = mats[0];
  const optText = applyHtml.match(/<option value="[^"]*">([^<]*)<\/option>/)[1];
  ok(optText.includes(first.name), `首个 option 显示物资名：${optText.slice(0, 40)}`);
  ok(/可申请\s*\d+/.test(optText), `option 含"可申请 N"：${optText}`);

  console.log('\n[2] 负责人提示区');
  ok(applyHtml.includes('id="aOwner"'), '存在负责人提示容器 aOwner');

  console.log('\n[3] 可申领物资页签');
  const listHtml = F.matListPage();
  const cards = (listHtml.match(/class="mcard"/g) || []).length;
  ok(cards === mats.length, `物资卡片 ${cards} 张（应等于 ${mats.length}）`);
  ok(listHtml.includes('负责老师'), '卡片标明负责老师');
  ok(/goApply\(/.test(listHtml), '卡片带「申领」按钮，可直达申领页');

  console.log('\n[4] 三个同名不同规格各自成条');
  const desks = mats.filter(m => m.name === '长条桌');
  ok(desks.length === 3, `长条桌 ${desks.length} 种规格`);
  const specs = desks.map(d => d.size).sort().join(' / ');
  ok(new Set(desks.map(d => d.size)).size === 3, `规格互不相同：${specs}`);
  for (const d of desks) {
    ok(applyHtml.includes(d.size), `  规格 ${d.size}（${d.available}${d.unit}）出现在下拉框`);
    ok(listHtml.includes(d.size), `  规格 ${d.size} 也独立出现在物资卡片`);
  }

  console.log('\n[5] warehouseView 我负责的物资');
  const whTok = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'wh006', password: 'demo1234' }),
  }).then(x => x.json());
  const saveTok = TOKEN; TOKEN = whTok.token;
  const myMats = await api('/api/materials');
  const whHtml = F.warehouseView([], myMats);
  const wc = (whHtml.match(/class="mcard"/g) || []).length;
  ok(wc === myMats.length, `张师傅名下 ${myMats.length} 种，卡片渲染 ${wc} 张`);
  TOKEN = saveTok;

  console.log('\n[6] 管理员视图与固定资产接口已下线');
  const admTok = await fetch(BASE + '/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'adm001', password: 'demo1234' }),
  }).then(x => x.json());
  TOKEN = admTok.token;
  const goneRes = await fetch(BASE + '/api/assets', {
    headers: { Authorization: 'Bearer ' + TOKEN },
  });
  ok(goneRes.status === 404, `固定资产接口已下线（/api/assets 返回 ${goneRes.status}）`);
  const admHtml = await F.adminView([]);
  ok(!/固定资产台账/.test(admHtml), '管理员视图不再包含固定资产页签');
  ok(/账实不符待核销|库存总览/.test(admHtml), '管理员视图正常渲染');

console.log('\n[7] 归还流程渲染');
  // 学生端：借用中→可提交归还；待清点→等老师；已归还→归档
  const stuHtml = F.returnBox([
    { id: 1, code: 'A1', material_name: '塑料凳', owner_name: '活动中心刘师傅', unit: '个',
      apply_qty: 10, approved_qty: 10, issued_qty: 10, status: 'in_use', status_text: '借用中' },
    { id: 2, code: 'A2', material_name: '马扎', owner_name: '田径场组王师傅', unit: '个',
      apply_qty: 5, issued_qty: 5, return_declared_qty: 5, status: 'return_submitted', status_text: '待老师清点' },
    { id: 3, code: 'A3', material_name: '黑皮椅', owner_name: '活动中心刘师傅', unit: '个',
      apply_qty: 8, issued_qty: 8, returned_qty: 8, status: 'returned', status_text: '已归还' },
  ]);
  ok(/我的借用与归还/.test(stuHtml), '归还页渲染正常');
  ok(/studentReturnGo\(1,10\)/.test(stuHtml), '借用中单据有「提交归还」按钮');
  ok(/等待田径场组王师傅清点/.test(stuHtml), '待清点单据显示等待该物资负责老师清点');
  ok(/已归还记录（1）/.test(stuHtml), '已归还记录独立成区');
  ok(!/studentReturnGo\(2,/.test(stuHtml), '待清点单据不再重复出现提交按钮');
  ok(/申报归还/.test(stuHtml), '表格含「申报归还」列，与实还区分');

  // 老师端：待清点与借用中分表，实还数量可填
  const whHtml2 = F.warehouseView([
    { id: 4, code: 'B1', material_name: '塑料凳', applicant_name: '张同学', unit: '个',
      issued_qty: 60, return_declared_qty: 58, return_photos: '["p1.jpg","p2.jpg"]',
      status: 'return_submitted', status_text: '待老师清点' },
    { id: 5, code: 'B2', material_name: '黑皮椅', applicant_name: '李同学', unit: '个',
      issued_qty: 20, status: 'in_use', status_text: '借用中' },
  ], []);
  ok(/待清点归还（1）/.test(whHtml2), '老师端出现「待清点归还」分区');
  ok(/id="rt4"[^>]*max="60"[^>]*value="58"/.test(whHtml2), '实还输入框默认带出学生申报量 58，上限为实发 60');
  ok(/学生已上传的照片可在详情页查看/.test(whHtml2), '老师可查看学生上传的照片（引导至详情页）');
  ok(/借用中·学生未提交归还（1）/.test(whHtml2), '未提交归还的借用单独立分区');
  ok(/returnGo\(4,60\)/.test(whHtml2) && /returnGo\(5,20\)/.test(whHtml2), '两张表都有清点登记按钮');

  console.log('\n[8] 详情为独立页面（非 alert 弹窗）');
  const sample = {
    id: 9, code: 'ZX20261014-009', material_name: '塑料凳', size: '标准',
    status: 'return_submitted', status_text: '待老师清点', unit: '个',
    applicant_no: '20230101', applicant_name: '张同学', borrower: '张同学', phone: '13800000000',
    material_category: '家具', location: '车队三楼', owner_name: '车队楼张师傅', owner_phone: '13900000000',
    use_start: '2026-10-15', use_end: '2026-10-20', purpose: '社团活动', deposit_note: '学生证',
    apply_qty: 60, approved_qty: 60, issued_qty: 60, return_declared_qty: 55, returned_qty: null, missing_qty: 0,
    return_photos: '["p1.jpg","p2.jpg"]',
    logs: [
      { action: '提交申领', operator_name: '张同学', created_at: '2026-10-14T09:00:00' },
      { action: '导师通过', operator_name: '李老师', created_at: '2026-10-14T10:00:00' },
    ],
    stock_logs: [
      { biz_type: 'issue', change_qty: -60, before_qty: 200, after_qty: 140, remark: '发放', created_at: '2026-10-14T11:00:00' },
    ],
  };
  const dh = F.detailPage(sample);
  ok(!/alert\(/.test(dh), '详情页不使用 alert 弹窗');
  ok(/onclick="detailBack\(\)"/.test(dh) && /← 返回列表/.test(dh), '详情页有「← 返回列表」按钮');
  ok(!/<script|onclick="render\(\)"/.test(dh), '详情页是独立内容区，不触发整页重渲染');
  for (const k of ['申请', '核定', '实发', '申报归还', '实还']) {
    ok(new RegExp('<div class="k">' + k + '</div>').test(dh), `数量链路含「${k}」`);
  }
  ok((dh.match(/class="qstep (on|zero)"/g) || []).length === 5, '数量链路恰好 5 段');
  ok(/申报归还<\/div><div class="v">55/.test(dh), '申报归还显示 55，与实还区分');
  ok(/实还<\/div><div class="v">-/.test(dh), '未登记实还时显示 -');
  ok(/流转记录（2）/.test(dh) && /<ul class="tl">/.test(dh), '含流转记录时间线');
  ok(/2026-10-14 09:00:00/.test(dh) && /李老师/.test(dh), '时间线含时间与操作人');
  ok(/库存流水（1）/.test(dh) && /变动前/.test(dh), '含库存流水表');
  ok(/归还凭证照片（2 张）/.test(dh), '含归还凭证照片区');

  // 缺失数量高亮
  const missHtml = F.detailPage(Object.assign({}, sample, { missing_qty: 5, returned_qty: 55 }));
  ok(/缺失待处理/.test(missHtml) && /已转学校物资丢失流程，不计入库存/.test(missHtml), '缺失 5 件高亮并标注不计入库存');

  // 无照片时不渲染空区块
  ok(!/归还凭证照片/.test(F.detailPage(Object.assign({}, sample, { return_photos: '' }))), '无照片时不渲染照片区');

  console.log('\n[9] 详情接口返回渲染所需字段');
  const myReqs = await api('/api/requests');
  if (myReqs.length) {
    const det = await api('/api/requests/' + myReqs[0].id);
    ok(!!det.material_name && !!det.code && 'status_text' in det, '详情接口返回单号/物资名/状态文案');
    ok(Array.isArray(det.logs) && Array.isArray(det.stock_logs), '详情接口返回 logs 与 stock_logs 数组');
    const dh2 = F.detailPage(Object.assign({}, det, { logs: det.logs || [], stock_logs: det.stock_logs || [] }));
    ok(/← 返回列表/.test(dh2), '真实单据详情可渲染');
  } else {
    ok(false, '当前账号没有单据可用于详情渲染验证');
  }

  console.log(fails === 0 ? '\n渲染验证通过 ✅' : `\n${fails} 项失败 ❌`);
  process.exit(fails === 0 ? 0 : 1);
})().catch((e) => { console.error('执行异常：', e.message); process.exit(1); });