'use strict';
/**
 * 真实数据导入 —— 周转物资平台
 *
 * 用法：
 *   node scripts/import-real.js --dry     只预览不写库
 *   node scripts/import-real.js           写入数据库
 *   node scripts/import-real.js --replace 清空周转物资后重新导入
 *
 * 数据来源（scripts/extract_sources.py 从两个 Excel 抽取）：
 *   1. 周转物资-车队三楼库存清单.xls  车队三楼床上用品，7 条
 *   2. 李师傅周转物资明细.xlsx         田径场 / 活动中心物资，11 条
 *
 * 说明：「资产信息查询.xlsx」中的固定资产已分配到具体部门/使用人，
 *      不属于周转物资申领范畴，本平台不导入。
 *
 * 关键规则：
 *   · 同名不同规格视为不同物资条目，各自独立库存
 *   · 数量带"+"（如 990+）时 total_qty 取下限，原始值存 qty_note
 */
const fs = require('node:fs');
const path = require('node:path');
const { db, now } = require('../server/db');

const PAYLOAD = path.join(__dirname, 'import_payload.json');
const DRY = process.argv.includes('--dry');
const REPLACE = process.argv.includes('--replace');

if (!fs.existsSync(PAYLOAD)) {
  console.error('未找到 import_payload.json，请先运行：python scripts/extract_sources.py');
  process.exit(1);
}
const payload = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'));

const SRC_CHEDUI = '周转物资-车队三楼库存清单.xls';
const SRC_LISHIFU = '李师傅周转物资明细.xlsx';

// 车队三楼清单的联系人统一是张巧玲，归到 wh006
const CHEDUI_OWNER = 'wh006';

function uid(username) {
  const r = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (!r) throw new Error(`负责老师账号不存在：${username}（请先让 db.js 完成 ensureUsers）`);
  return r.id;
}

// ---------- 清空 ----------
if (REPLACE) {
  const hasTraffic = db.prepare('SELECT COUNT(*) AS n FROM requests').get().n;
  if (hasTraffic > 0 && !DRY) {
    console.error(`拒绝执行：已有 ${hasTraffic} 条业务单据。请先运行 node scripts/reset.js`);
    process.exit(1);
  }
  db.exec('DELETE FROM stock_logs');
  db.exec('DELETE FROM inventory');
  db.exec('DELETE FROM materials');
  console.log('已清空既有周转物资数据');
}

// ---------- 导入周转物资 ----------
const insMat = db.prepare(
  `INSERT INTO materials (name,category,size,unit,location,owner_id,contact,phone,total_qty,qty_note,source_file,active,created_at)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?)`
);
const insInv = db.prepare('INSERT INTO inventory (material_id,available,reserved,updated_at) VALUES (?,?,0,?)');
const getMat = db.prepare('SELECT id FROM materials WHERE name = ? AND IFNULL(size,\'\') = ? AND location = ?');

let matCount = 0, qtySum = 0;
const t = now();

function putMaterial(row, unit, ownerUsername, source) {
  const ownerId = uid(ownerUsername);
  const owner = db.prepare('SELECT name, phone FROM users WHERE id = ?').get(ownerId);
  const exist = getMat.get(row.name, row.spec || '', row.location);
  if (exist) return { id: exist.id, skipped: true };

  const r = insMat.run(
    row.name, row.category || '其他', row.spec || '', unit || '件',
    row.location, ownerId, owner.name, owner.phone || row.phone || '',
    row.qty, row.qty_note || '', source, t
  );
  const id = Number(r.lastInsertRowid);
  insInv.run(id, row.qty, t);
  matCount++; qtySum += row.qty;
  return { id, skipped: false };
}

console.log(`\n===== 导入周转物资 =====`);
for (const row of payload.materials_chedui) {
  const unit = '件';
  const res = putMaterial(row, unit, CHEDUI_OWNER, SRC_CHEDUI);
  console.log(`  ${res.skipped ? '跳过' : '新增'} #${res.id} ${row.name} ${row.spec} ${row.qty}${unit} @ ${row.location} -> ${uid(CHEDUI_OWNER) ? '车队楼张巧玲' : ''}`);
}
for (const row of payload.materials_lishifu) {
  const res = putMaterial(row, row.unit, row.owner_username, SRC_LISHIFU);
  const note = row.qty_note ? ` [${row.qty_note}]` : '';
  console.log(`  ${res.skipped ? '跳过' : '新增'} #${res.id} ${row.name} ${row.spec || '-'} ${row.qty}${row.unit}${note} @ ${row.location} -> ${row.owner_name}`);
}

if (DRY) {
  console.log('\n[dry-run] 未写入数据库');
  process.exit(0);
}

console.log(`\n===== 导入结果 =====`);
console.log(`  周转物资 ${matCount} 条，库存合计 ${qtySum.toLocaleString()} 件`);
console.log(`  物资总条目 ${db.prepare('SELECT COUNT(*) AS n FROM materials').get().n}`);
console.log(`  按负责人分布：`);
for (const row of db.prepare(
  `SELECT u.username, u.name, COUNT(m.id) AS cnt, SUM(m.total_qty) AS qty
   FROM users u LEFT JOIN materials m ON m.owner_id = u.id
   WHERE u.role = 'warehouse' GROUP BY u.id ORDER BY u.id`
).all()) {
  console.log(`    ${row.username} ${row.name.padEnd(8, '　')} ${row.cnt} 种 ${row.qty || 0} 件`);
}
console.log('');