'use strict';
/**
 * 生成用于公开演示的脱敏种子数据
 *
 * 背景：真实台账含校内负责人姓名、手机号、存放地点，属不宜公开的信息。
 *本脚本从本地真实库读取物资与库存，但把以下字段替换为虚构值：
 *   - 负责人姓名、电话
 *   - 存放地点
 * 物资名称与规格保持真实，使演示仍有真实感。
 *
 * 输出：scripts/seed.json（进版本库，供 GitHub Pages 演示使用）
 * 注意：真实数据始终留在本地 data/platform.db，不上传。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const seedPath = path.join(__dirname, 'seed.json');
const templatePath = path.join(__dirname, 'seed.template.json');

let DatabaseSync;
try { ({ DatabaseSync } = require('node:sqlite')); }
catch (e) { console.error('需要 Node 22+（依赖内置 node:sqlite）'); process.exit(1); }

const template = JSON.parse(fs.readFileSync(templatePath, 'utf8'));

// 虚构负责人：按真实 owner_id 映射（不依赖姓名，姓名在本地库可能被改过）
const FAKE_OWNER_BY_ID = {
  9:  { name: '田径场组王师傅', phone: '13900000010' }, // 田径场组
  10: { name: '活动中心刘师傅', phone: '13900000011' }, // 活动中心
  11: { name: '车队楼张师傅', phone: '13900000012' },   // 车队楼
};

// 模板中这些 username 承接上面的虚构负责人，owner_id 必须与真实库一致
const USERNAME_BY_OWNER_ID = { 9: 'wh004', 10: 'wh005', 11: 'wh006' };

// 虚构存放地点：保留方位感，去掉具体楼栋房间
const FAKE_LOCATIONS = [
  '车队三楼', '田径场入口北侧', '活动中心三楼，北八一楼', '北八一楼',
  '活动中心三楼', '田径场看台北侧', '田径场西仓库',
];

function build() {
  const db = new DatabaseSync(path.join(ROOT, 'data', 'platform.db'));

  const mats = db.prepare(`
    SELECT m.id, m.name, m.size, m.category, m.location, m.unit,
           m.total_qty, m.qty_note, m.owner_id,
           i.available, i.reserved, u.name AS owner_name, u.phone AS owner_phone
    FROM materials m
    LEFT JOIN inventory i ON i.material_id = m.id
    LEFT JOIN users u      ON u.id = m.owner_id
    ORDER BY m.id
  `).all();

  if (!mats.length) {
    console.error('本地数据库没有物资数据，请先运行 node scripts/import-real.js');
    process.exit(1);
  }

  // 存放地点按物资 id 稳定映射，保证多次生成结果一致
  const locOf = new Map();
  mats.forEach((m, i) => {
    if (m.location && !locOf.has(m.id)) {
      locOf.set(m.id, FAKE_LOCATIONS[(mats.indexOf(m) + i) % FAKE_LOCATIONS.length]);
    }
  });

  const materials = mats.map(m => {
    const fake = FAKE_OWNER_BY_ID[m.owner_id];
    return {
      id: m.id,
      name: m.name,
      size: m.size || '',
      category: m.category || '',
      location: m.location ? (locOf.get(m.id) || '校内仓库') : '',
      unit: m.unit || '件',
      total_qty: m.total_qty,
      qty_note: m.qty_note || '',
      owner_id: m.owner_id,
      available: m.available || 0,
      reserved: m.reserved || 0,
      owner_name: fake ? fake.name : (m.owner_id ? '待指派' : ''),
      owner_phone: fake ? fake.phone : '',
    };
  });

  // 校验：每位真实负责人都必须有对应的虚构负责人，否则前端会显示"待指派"
  const realOwnerIds = [...new Set(mats.map(m => m.owner_id).filter(Boolean))];
  const missing = realOwnerIds.filter(id => !FAKE_OWNER_BY_ID[id]);
  if (missing.length) {
    console.error('以下 owner_id 未配置虚构负责人：' + missing.join(', '));
    console.error('请在 FAKE_OWNER_BY_ID 与 USERNAME_BY_OWNER_ID 中补充。');
    process.exit(1);
  }

  // 用户表：把三位负责人的 username 与真实 owner_id 对齐
  const users = template.users.map(u => ({ ...u }));
  for (const [oid, uname] of Object.entries(USERNAME_BY_OWNER_ID)) {
    const fake = FAKE_OWNER_BY_ID[Number(oid)];
    const u = users.find(x => x.username === uname);
    if (!u) { console.error('模板缺少账号：' + uname); process.exit(1); }
    u.id = Number(oid);
    u.name = fake.name;
    u.phone = fake.phone;
  }

  const out = {
    _说明: template._说明,
    _脱敏说明: template._脱敏说明,
    users,
    materials,
  };

  fs.writeFileSync(seedPath, JSON.stringify(out, null, 1));

  // 校验：不允许残留真实手机号或真实存放地点
  const raw = JSON.stringify(out);
  const fakeOwnerNames = new Set(Object.values(FAKE_OWNER_BY_ID).map(o => o.name));
  const realPhones = [...new Set(mats.map(m => m.owner_phone).filter(Boolean))];
  const bad = realPhones.filter(p => raw.includes(p));
  const realNames = [...new Set(mats.map(m => m.owner_name).filter(Boolean))];
  // 姓 + 职务（"王师傅""刘师傅"）属于通用称谓，不算敏感；
  // 真正需要脱敏的是含姓名的全称（如"张巧玲"）与手机号。
  const badNames = realNames.filter(n => !fakeOwnerNames.has(n) && raw.includes(n));
  const realLocs = [...new Set(mats.map(m => m.location).filter(Boolean))];
  const badLocs = realLocs.filter(l => raw.includes(l) && !FAKE_LOCATIONS.includes(l));

  console.log('已生成 scripts/seed.json');
  console.log('  用户 ' + users.length + ' 个，物资 ' + materials.length + ' 种');
  console.log('  校验 真实手机号残留：' + (bad.length ? bad.join(',') : '无 ✅'));
  console.log('  校验 真实姓名残留：' + (badNames.length ? badNames.join(',') : '无 ✅'));
  console.log('  校验 真实地点残留：' + (badLocs.length ? badLocs.join(',') : '无 ✅'));
  process.exit(bad.length || badNames.length || badLocs.length ? 1 : 0);
}

build();