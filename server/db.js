'use strict';
/**
 * 数据层 —— 周转物资平台
 * 说明：使用 Node 内置 node:sqlite，无需安装任何依赖。
 * 表结构里"申请/核定/实发/实还"四个数量字段是本项目的核心，库存只认后两个。
 */
const { DatabaseSync } = require('node:sqlite');
const path = require('node:path');
const fs = require('node:fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_FILE = path.join(DATA_DIR, 'platform.db');

const db = new DatabaseSync(DB_FILE);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

const SCHEMA = `
-- 用户表：OA 对接后，此表由 OA 下发的用户信息自动同步
CREATE TABLE IF NOT EXISTS users (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  username    TEXT UNIQUE NOT NULL,          -- 学号或工号
  name        TEXT NOT NULL,
  role        TEXT NOT NULL,                 -- student|mentor|warehouse|asset_admin
  dept        TEXT,
  phone       TEXT,
  source      TEXT NOT NULL DEFAULT 'local', -- local | oa  (标识身份来源)
  active      INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL
);

-- 物资档案
-- owner_id：该种物资的负责老师（warehouse 角色）。学生申请后，单据只会路由给这位老师，
-- 其他仓库老师看不到、也无权核定/发放/归还。资产管理员可随时改绑。
-- qty_note：源清单里数量带"约"或"+"时（如"990+"），把原始文本存这里，
-- total_qty 存可确认的下限，避免把不确定的数量当成精确值参与核定。
CREATE TABLE IF NOT EXISTS materials (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  category     TEXT,
  size         TEXT,
  unit         TEXT NOT NULL DEFAULT '件',
  photo_url    TEXT,
  location     TEXT NOT NULL,
  owner_id     INTEGER REFERENCES users(id),   -- 负责老师（warehouse）
  contact      TEXT,
  phone        TEXT,
  total_qty    INTEGER NOT NULL DEFAULT 0,   -- 购置总量
  qty_note     TEXT,                            -- 数量备注，如"约990+"
  source_file  TEXT,                            -- 数据来源文件，便于追溯核对
  active       INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);

-- 库存台账：可用量由变动流水唯一定义
-- reserved 为"已核定待发放"的预占量，核定环节即锁定，避免超发核定
CREATE TABLE IF NOT EXISTS inventory (
  material_id  INTEGER PRIMARY KEY REFERENCES materials(id),
  available    INTEGER NOT NULL DEFAULT 0,
  reserved     INTEGER NOT NULL DEFAULT 0,
  updated_at   TEXT
);

-- 申领单：部分通过时生成新单并用 parent_id 关联原单，原单不覆盖
CREATE TABLE IF NOT EXISTS requests (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  code           TEXT UNIQUE NOT NULL,
  material_id    INTEGER NOT NULL REFERENCES materials(id),
  applicant_id   INTEGER NOT NULL REFERENCES users(id),
  apply_qty      INTEGER NOT NULL,            -- 申请数量
  approved_qty   INTEGER,                      -- 仓库核定数量
  issued_qty     INTEGER,                      -- 实际发放数量
  returned_qty   INTEGER,                      -- 实际归还数量
  missing_qty    INTEGER NOT NULL DEFAULT 0,   -- 缺失待处理数量
  purpose        TEXT,
  use_start      TEXT,
  use_end        TEXT,
  dept           TEXT,
  borrower       TEXT,
  phone          TEXT,
  status         TEXT NOT NULL,
  parent_id      INTEGER REFERENCES requests(id),
  return_photos      TEXT,                         -- 学生上传的归还凭证照片(JSON 数组)
  return_declared_qty INTEGER,                     -- 学生申报的归还数量(待老师清点核对)
  return_submitted_at TEXT,                        -- 学生提交归还申请的时间
  deposit_note   TEXT,                         -- 学生证抵押等线下备注
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL
);

-- 单据状态流转日志（只追加）
CREATE TABLE IF NOT EXISTS request_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  request_id   INTEGER NOT NULL REFERENCES requests(id),
  action       TEXT NOT NULL,
  from_status  TEXT,
  to_status    TEXT,
  operator_id  INTEGER REFERENCES users(id),
  note         TEXT,
  created_at   TEXT NOT NULL
);

-- 库存变动流水：只追加，不修改
CREATE TABLE IF NOT EXISTS stock_logs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  material_id  INTEGER NOT NULL REFERENCES materials(id),
  change_qty   INTEGER NOT NULL,              -- 正数回增，负数扣减
  before_qty   INTEGER NOT NULL,
  after_qty    INTEGER NOT NULL,
  biz_type     TEXT NOT NULL,                 -- issue | return | adjust
  ref_code     TEXT,
  operator_id  INTEGER REFERENCES users(id),
  remark       TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_req_status  ON requests(status);
CREATE INDEX IF NOT EXISTS idx_req_applier ON requests(applicant_id);
CREATE INDEX IF NOT EXISTS idx_log_material ON stock_logs(material_id);
CREATE INDEX IF NOT EXISTS idx_mat_owner   ON materials(owner_id);
`;

// ---------- 增量迁移（老库补列，不丢数据）----------
function migrate() {
  const addIfMissing = (table, col, ddl) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  addIfMissing('materials', 'owner_id', 'owner_id INTEGER REFERENCES users(id)');
  addIfMissing('materials', 'qty_note', 'qty_note TEXT');
  addIfMissing('materials', 'source_file', 'source_file TEXT');
  // 归还流程：学生提交归还申请(拍照) → 负责老师清点登记 → 账实核对
  addIfMissing('requests', 'return_photos', 'return_photos TEXT');
  addIfMissing('requests', 'return_declared_qty', 'return_declared_qty INTEGER');
  addIfMissing('requests', 'return_submitted_at', 'return_submitted_at TEXT');

  // 本平台只管周转物资。早期版本误建了 assets 表存放"资产信息查询"里的固定资产，
  // 但那些资产已分配到部门/个人、走资产帐，不属于物资申领范畴，这里物理删除。
  const hasAssets = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assets'").get();
  if (hasAssets) {
    db.exec('DROP TABLE assets');
    console.log('[db] 已移除 assets 表（固定资产不属于周转物资范畴）');
  }
}
migrate();

db.exec(SCHEMA);

const now = () => new Date().toISOString();

// ---------- 演示账号（幂等补齐，老库缺谁补谁）----------
const DEMO_USERS = [
  ['stu001', '张同学', 'student', '计算机学院', '13800000001'],
  ['stu002', '李同学', 'student', '外国语学院', '13800000002'],
  ['mentor01', '王老师', 'mentor', '计算机学院', '13800000003'],
  ['mentor02', '刘老师', 'mentor', '外国语学院', '13800000008'],
  ['wh001', '赵老师', 'warehouse', '资产中心一号库', '13800000004'],
  ['wh002', '周老师', 'warehouse', '资产中心二号库', '13800000006'],
  ['wh003', '孙老师', 'warehouse', '操场西侧仓库', '13800000007'],
  // 以下为真实清单中的物资负责人
  ['wh004', '田径场组王师傅', 'warehouse', '田径场', '15936275379'],
  ['wh005', '活动中心刘师傅', 'warehouse', '活动中心', '15936275380'],
  ['wh006', '车队楼张巧玲', 'warehouse', '车队三楼', '15936275378'],
  ['adm001', '资产管理员', 'asset_admin', '财务资产处', '13800000005'],
];
const uid = (uname) => db.prepare('SELECT id FROM users WHERE username = ?').get(uname)?.id;

function ensureUsers() {
  const ins = db.prepare(
    'INSERT INTO users (username,name,role,dept,phone,source,created_at) VALUES (?,?,?,?,?,?,?)'
  );
  const has = db.prepare('SELECT username FROM users WHERE username = ?');
  const t = now();
  for (const u of DEMO_USERS) {
    if (!has.get(u[0])) ins.run(u[0], u[1], u[2], u[3], u[4], 'local', t);
  }
}
ensureUsers();

// ---------- 演示数据 ----------
function seed() {
  const c = db.prepare('SELECT COUNT(*) AS n FROM materials').get();
  if (c.n > 0) return;
  const nowStr = now();

  const insMat = db.prepare(
    'INSERT INTO materials (name,category,size,unit,photo_url,location,owner_id,contact,phone,total_qty,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)'
  );
  const mats = [
    ['折叠椅', '桌椅', '标准', '把', '/img/chair.svg', '资产中心一号库', 'wh001', '赵老师', '13800000004', 200],
    ['长条桌', '桌椅', '1.8m', '张', '/img/table.svg', '资产中心一号库', 'wh001', '赵老师', '13800000004', 80],
    ['讲台音箱', '音响', '便携式', '套', '/img/speaker.svg', '资产中心二号库', 'wh002', '周老师', '13800000006', 24],
    ['笔记本电脑', '电子设备', '14 寸', '台', '/img/laptop.svg', '资产中心二号库', 'wh002', '周老师', '13800000006', 15],
    ['投影仪', '电子设备', '1080P', '台', '/img/projector.svg', '资产中心二号库', 'wh002', '周老师', '13800000006', 12],
    ['遮阳棚', '户外', '3x3m', '顶', '/img/tent.svg', '操场西侧仓库', 'wh003', '孙老师', '13800000007', 30],
  ];
  const insInv = db.prepare('INSERT INTO inventory (material_id,available,reserved,updated_at) VALUES (?,?,0,?)');
  for (const m of mats) {
    const r = insMat.run(m[0], m[1], m[2], m[3], m[4], m[5], uid(m[6]), m[7], m[8], m[9], nowStr);
    insInv.run(Number(r.lastInsertRowid), m[9], nowStr);
  }
}
seed();

// ---------- 物资负责人绑定 ----------
// 优先按contact 里的老师姓名精确回绑；匹配不到再按存放地点对应的仓库老师；
// 仍匹配不到才兜底给第一位仓库老师，确保不存在"无人负责"的物资。
function backfillOwners() {
  const whs = db.prepare("SELECT id,name,dept FROM users WHERE role = 'warehouse'").all();
  if (!whs.length) return;
  // 只处理 owner_id 为空的行（老数据兜底）。已有绑定的绝不覆盖——
  // 真实清单导入时已显式指定负责人，按 location 反推 dept 会误伤（如"田径场" ≠ "田径场看台北侧"）
  const byName = db.prepare('UPDATE materials SET owner_id = ? WHERE owner_id IS NULL AND contact = ?');
  const byDept = db.prepare('UPDATE materials SET owner_id = ? WHERE owner_id IS NULL AND location = ?');
  let n = 0;
  for (const w of whs) {
    n += byName.run(w.id, w.name).changes;
    n += byDept.run(w.id, w.dept).changes;
  }
  n += db.prepare('UPDATE materials SET owner_id = ? WHERE owner_id IS NULL').run(whs[0].id).changes;
  // 同步冗余的 contact / phone，前端列表不用再 JOIN 也能显示负责人
  db.prepare(
    'UPDATE materials SET contact = (SELECT name FROM users WHERE id = materials.owner_id), phone = (SELECT phone FROM users WHERE id = materials.owner_id) WHERE owner_id IS NOT NULL'
  ).run();
  if (n) console.log(`[db] 已为 ${n} 种物资绑定负责老师`);
}
backfillOwners();

module.exports = { db, now };
