'use strict';
/**
 * 业务服务层 —— 申领单状态机
 *
 * 状态流转：
 *   pending_mentor  待导师审批
 *     ├─ 导师通过 → pending_warehouse 待仓库核库存
 *     └─ 导师驳回 → rejected已驳回
 *   pending_warehouse
 *     ├─ 完全通过 → to_issue 待发放
 *     └─ 部分通过 → 新生成改单(pending_mentor)，原单标记 partial_closed
 *   to_issue → (仓库发放，按实发扣库存) → in_use 借用中
 *   in_use → (学生提交归还申请 + 拍照) → return_submitted 待老师清点
 *   return_submitted → (老师清点登记，按实还回增库存) → returned / mismatch
 *   in_use → (老师直接清点登记，学生未线上申请) → returned / mismatch
 *   mismatch → (资产处核销缺失) → closed
 */
const { db, now } = require('./db');
const inventory = require('./inventory');
const approval = require('./approval-adapter');

const ROLES = {
  student: '学生',
  mentor: '导师',
  warehouse: '仓库老师',
  asset_admin: '资产管理员',
};

const STATUS_TEXT = {
  pending_mentor: '待导师审批',
  pending_warehouse: '待仓库核库存',
  to_issue: '待发放',
  in_use: '借用中',
  return_submitted: '待老师清点',
  returned: '已归还',
  partial_closed: '部分通过已终止',
  rejected: '已驳回',
  mismatch: '账实不符待处理',
  closed: '已核销',
};

let seq = 0;
function genCode() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  // 追加进程内自增序号，避免同一秒内并发生成重复单号
  seq = (seq + 1) % 10000;
  return `WZ${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}${p(seq, 4)}`;
}

function logAction(requestId, action, from, to, operatorId, note = '') {
  db.prepare(
    'INSERT INTO request_logs (request_id,action,from_status,to_status,operator_id,note,created_at) VALUES (?,?,?,?,?,?,?)'
  ).run(requestId, action, from, to, operatorId, note, now());
}

function getRequest(id) {
  return db
    .prepare(
      `SELECT r.*, m.name AS material_name, m.unit, m.location, m.contact, m.phone,
              m.owner_id AS material_owner_id, m.category AS material_category,
              o.name AS owner_name, o.phone AS owner_phone,
              u.name AS applicant_name, u.username AS applicant_no, u.dept AS applicant_dept
       FROM requests r
       JOIN materials m ON m.id = r.material_id
       LEFT JOIN users o ON o.id = m.owner_id
       JOIN users u ON u.id = r.applicant_id
       WHERE r.id = ?`
    )
    .get(id);
}

/**
 * 负责老师校验：每种物资绑定一位负责老师（materials.owner_id），
 * 单据只会路由给这位老师。其他仓库老师既看不到单据，也无权核定/发放/归还。
 * 资产管理员（财务资产处）拥有全局视图，不受此限。
 */
function assertOwner(user, req) {
  if (user.role === 'asset_admin') return;
  if (user.role !== 'warehouse') throw new Error('无权限：仅该物资的负责老师或资产管理员可操作');
  if (!req.material_owner_id) throw new Error('该物资尚未绑定负责老师，请联系资产管理员');
  if (req.material_owner_id !== user.id) {
    throw new Error(`该物资由「${req.owner_name || '其他老师'}」负责，无权操作此单`);
  }
}

// ---------- 学生：提交申领 ----------
function createRequest(user, body) {
  const materialId = Number(body.material_id);
  const applyQty = Number(body.apply_qty);
  if (!materialId || !Number.isInteger(applyQty) || applyQty <= 0) {
    throw new Error('物资与申请数量不能为空');
  }
  const mat = db.prepare('SELECT * FROM materials WHERE id = ? AND active = 1').get(materialId);
  if (!mat) throw new Error('物资不存在或已下架');

  const t = now();
  const r = db
    .prepare(
      `INSERT INTO requests
        (code,material_id,applicant_id,apply_qty,purpose,use_start,use_end,dept,borrower,phone,status,parent_id,deposit_note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      genCode(), materialId, user.id, applyQty, body.purpose || '', body.use_start || '',
      body.use_end || '', user.dept || '', body.borrower || user.name, body.phone || user.phone || '',
      'pending_mentor', body.parent_id ? Number(body.parent_id) : null,
      body.deposit_note || '', t, t
    );
  const id = Number(r.lastInsertRowid);
  logAction(id, '提交申领', null, 'pending_mentor', user.id);
  return getRequest(id);
}

// ---------- 导师：审批 ----------
async function mentorApprove(user, id, pass, note = '') {
  const req = getRequest(id);
  if (!req) throw new Error('单据不存在');
  if (req.status !== 'pending_mentor') throw new Error('当前状态不可由导师审批');
  if (user.role !== 'mentor') throw new Error('无权限：仅导师可审批');

  const to = pass ? 'pending_warehouse' : 'rejected';
  db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run(to, now(), id);
  logAction(id, pass ? '导师通过' : '导师驳回', req.status, to, user.id, note);

  if (pass) {
    // 待办只推给该种物资的负责老师，而非所有仓库老师
    await approval.current.pushTodo(
      { ...req, id },
      { role: 'warehouse', assigneeId: req.material_owner_id, assigneeName: req.owner_name }
    );
  }
  return getRequest(id);
}

// ---------- 仓库老师：核定数量（完全 / 部分通过）----------
async function warehouseCheck(user, id, approvedQty, note = '') {
  const req = getRequest(id);
  if (!req) throw new Error('单据不存在');
  if (req.status !== 'pending_warehouse') throw new Error('当前状态不可核定');
  if (user.role !== 'warehouse' && user.role !== 'asset_admin') {
    throw new Error('无权限：仅仓库老师可核定');
  }
  assertOwner(user, req);

  const n = Number(approvedQty);
  if (!Number.isInteger(n) || n < 0) throw new Error('核定数量必须是非负整数');

  // 核定即预占，杜绝"核定通过却发不出去"（并发超发核定）。
  // 余量判定在 inventory.reserve 的原子 SQL 内完成，此处不做先读后判。
  inventory.reserve(req.material_id, n, {
    refCode: req.code, operatorId: user.id, remark: `核定 ${req.code}`,
  });

  const t = now();
  if (n === req.apply_qty) {
    // 完全通过
    db.prepare('UPDATE requests SET approved_qty = ?, status = ?, updated_at = ? WHERE id = ?').run(
      n, 'to_issue', t, id
    );
    logAction(id, '核定为完全通过', req.status, 'to_issue', user.id, note);
    return getRequest(id);
  }

  // 部分通过：新生成改单，原单终止但保留申请数量记录
  // 原单的预占额度让给改单，避免预占被原单长期占用
  inventory.release(req.material_id, n, {
    refCode: req.code, operatorId: user.id, remark: '部分通过改单，预占额度转交改单',
  });
  const code = genCode();
  const r = db
    .prepare(
      `INSERT INTO requests
        (code,material_id,applicant_id,apply_qty,approved_qty,purpose,use_start,use_end,dept,borrower,phone,status,parent_id,deposit_note,created_at,updated_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    )
    .run(
      code, req.material_id, req.applicant_id, n, n, req.purpose, req.use_start, req.use_end,
      req.dept, req.borrower, req.phone, 'pending_mentor', req.id, req.deposit_note, t, t
    );
  const newId = Number(r.lastInsertRowid);
  // 改单重新进入导师审批，暂不占用预占；待再次核定时再预占
  db.prepare('UPDATE requests SET approved_qty = ?, status = ?, updated_at = ? WHERE id = ?').run(
    n, 'partial_closed', t, id
  );
  logAction(id, `核定为部分通过 (核定 ${n}/${req.apply_qty})`, req.status, 'partial_closed', user.id, note);
  logAction(newId, '由部分通过改单生成', null, 'pending_mentor', user.id, `原单 ${req.code}`);
  await approval.current.pushTodo(getRequest(newId), { role: 'mentor' });
  return { origin: getRequest(id), created: getRequest(newId) };
}

// ---------- 仓库老师：发放（按实发扣库存）----------
function warehouseIssue(user, id, issuedQty, depositNote = '') {
  const req = getRequest(id);
  if (!req) throw new Error('单据不存在');
  if (req.status !== 'to_issue') throw new Error('当前状态不可发放');
  if (user.role !== 'warehouse' && user.role !== 'asset_admin') {
    throw new Error('无权限：仅仓库老师可发放');
  }
  assertOwner(user, req);
  const n = Number(issuedQty);
  if (!Number.isInteger(n) || n <= 0) throw new Error('实发数量必须是正整数');
  if (n > (req.approved_qty || 0)) throw new Error(`实发数量不能超过核定数量 ${req.approved_qty}`);

  // 扣减库存：按实发数量，绝不按申请数量
  // changeStock 内部会把预占减少 n；实发少于核定数时，额外释放差额
  const res = inventory.changeStock(req.material_id, -n, {
    bizType: 'issue', refCode: req.code, operatorId: user.id,
    remark: `发放给${req.borrower || req.applicant_name}`,
  });
  if (res.skipped) return getRequest(id);

  const unused = (req.approved_qty || 0) - n;
  if (unused > 0) {
    inventory.release(req.material_id, unused, {
      refCode: req.code + '-R', operatorId: user.id,
      remark: `实发少于核定，释放差额 ${unused}`,
    });
  }

  const t = now();
  db.prepare(
    'UPDATE requests SET issued_qty = ?, status = ?, deposit_note = ?, updated_at = ? WHERE id = ?'
  ).run(n, 'in_use', depositNote || req.deposit_note, t, id);
  logAction(id, `发放 ${n}${req.unit}并扣减库存 (${res.before}→${res.after})`, 'to_issue', 'in_use', user.id, depositNote);
  return getRequest(id);
}

// ---------- 学生：提交归还申请（拍照上传，转负责老师清点）----------
/**
 * 真实流程是「学生现场归还 → 拍照上传 → 仓库老师清点并登记实际归还数量」。
 * 所以归还分两步：
 *   1. 学生线上提交归还申请（必须带照片），单据转 return_submitted，等老师清点；
 *      此时不动库存，因为实还数量还没确认。
 *   2. 老师清点后调用 returnRequest 登记实还数量，此时才回增库存。
 */
function submitReturn(user, id, declaredQty, photos = []) {
  const req = getRequest(id);
  if (!req) throw new Error('单据不存在');
  if (req.status !== 'in_use') throw new Error('当前状态不可提交归还申请');
  if (user.role !== 'student' && user.role !== 'asset_admin') {
    throw new Error('无权限：仅借用人本人可提交归还申请');
  }
  if (user.role === 'student' && req.applicant_id !== user.id) {
    throw new Error('只能归还自己借用的物资');
  }
  const n = Number(declaredQty);
  if (!Number.isInteger(n) || n <= 0) throw new Error('申报归还数量必须是正整数');
  if (n > req.issued_qty) throw new Error(`申报归还数量不能超过实发数量 ${req.issued_qty}`);
  if (!Array.isArray(photos) || photos.length === 0) {
    throw new Error('请上传至少一张归还照片作为凭证');
  }

  const t = now();
  db.prepare(
    `UPDATE requests
     SET status = 'return_submitted', return_declared_qty = ?, return_photos = ?,
         return_submitted_at = ?, updated_at = ?
     WHERE id = ?`
  ).run(n, JSON.stringify(photos), t, t, id);
  logAction(
    id,
    `学生提交归还申请，申报 ${n}${req.unit}，照片 ${photos.length} 张，等待${req.owner_name || '负责老师'}清点`,
    'in_use', 'return_submitted', user.id
  );

  // 通知该物资负责老师去清点（OA 场景下走待办推送）
  if (approval.current.pushTodo) {
    approval.current.pushTodo(req, {
      role: 'warehouse',
      assigneeId: req.material_owner_id,
      assigneeName: req.owner_name,
      title: '待清点归还',
    }).catch(() => {});
  }
  return getRequest(id);
}

// ---------- 老师清点登记（按实还回增库存）----------
/**
 * returnedQty 为老师现场清点的实际数量，可能与学生申报量不一致
 * （例如学生申报还60，实物只有58）。一律以老师清点结果为准。
 */
function returnRequest(user, id, returnedQty, photos = []) {
  const req = getRequest(id);
  if (!req) throw new Error('单据不存在');
  if (req.status !== 'in_use' && req.status !== 'return_submitted') {
    throw new Error('当前状态不可归还');
  }
  // 归还由负责老师清点确认；学生提交后仍需该老师操作
  assertOwner(user, req);
  const n = Number(returnedQty);
  if (!Number.isInteger(n) || n < 0) throw new Error('实还数量必须是非负整数');
  if (n > req.issued_qty) throw new Error(`实还数量不能超过实发数量 ${req.issued_qty}`);

  // 凭证照片：老师可补传；若学生已线上提交过照片则沿用，无需重复上传
  let photosJson = '';
  if (Array.isArray(photos) && photos.length > 0) {
    photosJson = JSON.stringify(photos);
  } else if (req.return_photos) {
    photosJson = req.return_photos;
  } else {
    throw new Error('请上传至少一张归还照片作为凭证');
  }
  const photoCount = JSON.parse(photosJson || '[]').length;
  const from = req.status;

  if (n > 0) {
    const res = inventory.changeStock(req.material_id, n, {
      bizType: 'return', refCode: req.code, operatorId: user.id,
      remark: `归还 ${n}${req.unit}`,
    });
    if (!res.skipped) {
      logAction(id, `归还 ${n}${req.unit}回增库存 (${res.before}→${res.after})`, from, from, user.id);
    }
  }

  // 账实核对：差额只标记，不写入库存
  const missing = req.issued_qty - n;
  const to = missing > 0 ? 'mismatch' : 'returned';
  const t = now();
  db.prepare(
    `UPDATE requests
     SET returned_qty = ?, missing_qty = ?, status = ?, return_photos = ?, updated_at = ?
     WHERE id = ?`
  ).run(n, missing, to, photosJson, t, id);

  // 学生申报量与老师清点结果不一致时，差额也进丢失流程
  const declared = req.return_declared_qty;
  const drift = declared != null && declared !== n
    ? `；学生申报 ${declared}${req.unit}，实清点 ${n}${req.unit}，差 ${Math.abs(declared - n)}`
    : '';
  logAction(
    id,
    (missing > 0 ? `归还 ${n}${req.unit}，缺失 ${missing} 转丢失处理流程` : `归还 ${n}${req.unit}，账实相符`) + drift,
    from, to, user.id,
    `凭证照片 ${photoCount} 张`
  );
  return getRequest(id);
}

// ---------- 资产处：核销缺失 ----------
function closeMismatch(user, id, note = '') {
  const req = getRequest(id);
  if (!req) throw new Error('单据不存在');
  if (req.status !== 'mismatch') throw new Error('仅账实不符的单据可核销');
  if (user.role !== 'asset_admin') throw new Error('无权限：仅资产管理员可核销');
  const t = now();
  db.prepare('UPDATE requests SET status = ?, updated_at = ? WHERE id = ?').run('closed', t, id);
  logAction(id, `缺失 ${req.missing_qty}${req.unit} 已核销（未计入库存）`, 'mismatch', 'closed', user.id, note);
  return getRequest(id);
}

// ---------- 查询 ----------
function listRequests(user, filter = {}) {
  const where = [];
  const args = [];
  if (user.role === 'student') { where.push('r.applicant_id = ?'); args.push(user.id); }
  if (user.role === 'mentor' && filter.stage !== 'all') { where.push('r.status = ?'); args.push('pending_mentor'); }
  if (user.role === 'warehouse') {
    // 关键：仓库老师只处理自己负责的物资，单据按 materials.owner_id 路由
    where.push('m.owner_id = ?'); args.push(user.id);
    // 待清点：学生已提交归还申请，等这位老师现场清点登记
    if (filter.stage !== 'all') { where.push("r.status IN ('pending_warehouse','to_issue','return_submitted')"); }
  }
  const sql =
    `SELECT r.id,r.code,r.apply_qty,r.approved_qty,r.issued_qty,r.returned_qty,r.missing_qty,
            r.status,r.created_at,r.use_start,r.use_end,
            r.return_declared_qty,r.return_photos,r.return_submitted_at,r.borrower,r.phone,
            m.name AS material_name,m.unit,
            m.owner_id AS material_owner_id,o.name AS owner_name,
            u.name AS applicant_name
     FROM requests r
     JOIN materials m ON m.id=r.material_id
     LEFT JOIN users o ON o.id = m.owner_id
     JOIN users u ON u.id=r.applicant_id
     ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
     ORDER BY r.id DESC LIMIT 200`;
  return db.prepare(sql).all(...args).map((r) => ({
    ...r,
    status_text: STATUS_TEXT[r.status] || r.status,
    mine: user.role === 'warehouse' ? r.material_owner_id === user.id : undefined,
  }));
}

// ---------- 仓库老师：我负责的物资清单 ----------
function listMyMaterials(user) {
  if (user.role !== 'warehouse') {
    return db
      .prepare(
        `SELECT m.*, i.available, i.reserved, o.name AS owner_name
         FROM materials m JOIN inventory i ON i.material_id = m.id
         LEFT JOIN users o ON o.id = m.owner_id
         WHERE m.active = 1 ORDER BY m.id`
      )
      .all();
  }
  return db
    .prepare(
      `SELECT m.*, i.available, i.reserved, o.name AS owner_name
       FROM materials m JOIN inventory i ON i.material_id = m.id
       LEFT JOIN users o ON o.id = m.owner_id
       WHERE m.active = 1 AND m.owner_id = ? ORDER BY m.id`
    )
    .all(user.id);
}

// ---------- 资产管理员：改绑物资负责老师 ----------
function assignOwner(user, materialId, ownerId) {
  if (user.role !== 'asset_admin') throw new Error('无权限：仅资产管理员可改绑负责老师');
  const mid = Number(materialId);
  const oid = Number(ownerId);
  const mat = db.prepare('SELECT * FROM materials WHERE id = ?').get(mid);
  if (!mat) throw new Error('物资不存在');
  const owner = db.prepare("SELECT * FROM users WHERE id = ? AND role = 'warehouse'").get(oid);
  if (!owner) throw new Error('指定的负责老师不存在，或其角色不是仓库老师');

  db.prepare('UPDATE materials SET owner_id = ?, contact = ?, phone = ? WHERE id = ?')
    .run(oid, owner.name, owner.phone || '', mid);
  return db
    .prepare(
      `SELECT m.*, i.available, i.reserved, o.name AS owner_name
       FROM materials m JOIN inventory i ON i.material_id = m.id
       LEFT JOIN users o ON o.id = m.owner_id WHERE m.id = ?`
    )
    .get(mid);
}

function getRequestDetail(id) {
  const req = getRequest(id);
  if (!req) return null;
  req.status_text = STATUS_TEXT[req.status] || req.status;
  req.logs = db
    .prepare(
      `SELECT l.*, u.name AS operator_name FROM request_logs l
       LEFT JOIN users u ON u.id = l.operator_id WHERE l.request_id = ? ORDER BY l.id ASC`
    )
    .all(id);
  req.stock_logs = inventory.listStockLogs(req.material_id, 20).filter((l) => l.ref_code === req.code);
  return req;
}

module.exports = {
  ROLES, STATUS_TEXT,
  createRequest, mentorApprove, warehouseCheck, warehouseIssue,
  returnRequest, submitReturn, closeMismatch, listRequests, getRequestDetail,
  listMyMaterials, assignOwner,
  listWarehouseStaff: () =>
    db.prepare("SELECT id,username,name,dept,phone FROM users WHERE role = 'warehouse' AND active = 1 ORDER BY id").all(),
};
