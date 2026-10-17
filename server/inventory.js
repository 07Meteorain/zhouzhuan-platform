'use strict';
/**
 * 库存服务 —— 库存增减与预占的唯一入口
 *
 * 铁律（全项目必须遵守）：
 *  1. 任何代码路径都不得直接 UPDATE inventory 表，只有本文件能写。
 *  2. 扣减按"实际发放数量"，回增按"实际归还数量"，绝不按申请数量。
 *  3. 扣减必须带 available >= n 条件，天然防超卖；配合事务与幂等校验。
 *  4. 账实不符时，差额只标记到单据（missing_qty），绝不写入库存。
 *  5. 每次变动必须写 stock_logs，只追加不修改。
 *  6. 核定环节用 reserve() 预占，避免"核定通过却发不出去"（超发核定）。
 *
 * 两个量的含义：
 *   available 实物在库量
 *   reserved  已核定待发放量
 *   可发放上限 = available
 */
const { db, now } = require('./db');

function readInv(materialId) {
  const r = db.prepare('SELECT available, reserved FROM inventory WHERE material_id = ?').get(materialId);
  if (!r) throw new Error('物资库存记录不存在: ' + materialId);
  return r;
}

function getAvailable(materialId) {
  return readInv(materialId).available;
}
function getReserved(materialId) {
  return readInv(materialId).reserved;
}

/**
 * 预占（核定环节）：锁定 n 件待发放，可用量不足则拒绝
 * 这是"核定"与"发放"之间的防线，防止核定数超过实物
 */
function reserve(materialId, n, opts = {}) {
  const { refCode = '', operatorId = null, remark = '' } = opts;
  if (!Number.isInteger(n) || n < 0) throw new Error('预占数量必须是非负整数');
  if (n === 0) return { before: readInv(materialId), skipped: true };

  // 原子条件更新：把"检查可发放余量"和"累加预占"合成一条 SQL。
  // 判定口径是 available - reserved（实物在库但已被他人预占的部分不能再批），
  // 这样并发核定不会被同一批物资重复批准，从根本上杜绝超发核定。
  const r = db
    .prepare(
      `UPDATE inventory SET reserved = reserved + ?, updated_at = ?
       WHERE material_id = ? AND (available - reserved) >= ?`
    )
    .run(n, now(), materialId, n);

  if (r.changes === 0) {
    const cur = readInv(materialId);
    const free = cur.available - cur.reserved;
    throw new Error(
      free <= 0
        ? `可用库存不足：${cur.available} 件在库均已被其他单据核定预占`
        : `可用库存不足：当前可发放 ${free}，本次需核定 ${n}`
    );
  }

  const cur = readInv(materialId);
  db.prepare(
    'INSERT INTO stock_logs (material_id,change_qty,before_qty,after_qty,biz_type,ref_code,operator_id,remark,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(materialId, 0, cur.available, cur.available, 'reserve', refCode, operatorId,
    `核定预占 ${n}（预留 →${cur.reserved}）`, now());
  return { after: cur, skipped: false };
}

/**
 * 释放预占（单据被撤销 / 改单 / 归还异常回退时）
 */
function release(materialId, n, opts = {}) {
  const { refCode = '', operatorId = null, remark = '' } = opts;
  if (!Number.isInteger(n) || n <= 0) return { skipped: true };
  const r = db
    .prepare(
      `UPDATE inventory SET reserved = MAX(0, reserved - ?), updated_at = ?
       WHERE material_id = ?`
    )
    .run(n, now(), materialId);
  if (r.changes === 0) throw new Error('物资库存记录不存在: ' + materialId);
  const cur = readInv(materialId);
  db.prepare(
    'INSERT INTO stock_logs (material_id,change_qty,before_qty,after_qty,biz_type,ref_code,operator_id,remark,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(materialId, 0, cur.available, cur.available, 'release', refCode, operatorId,
    `释放预占 ${n}（预留 →${cur.reserved}）${remark ? ' ' + remark : ''}`, now());
  return { after: cur };
}

/**
 * 唯一的实物库存写入口
 * @param {number} materialId
 * @param {number} delta    负数扣减（发放），正数回增（归还）
 */
function changeStock(materialId, delta, opts = {}) {
  const { bizType, refCode = '', operatorId = null, remark = '' } = opts;
  if (!Number.isInteger(delta) || delta === 0) {
    throw new Error('库存变动数量必须是非零整数');
  }
  if (!['issue', 'return', 'adjust'].includes(bizType)) {
    throw new Error('非法的库存变动类型: ' + bizType);
  }

  // 幂等校验：同一单据同一业务类型只记一次流水
  if (refCode) {
    const dup = db
      .prepare('SELECT id FROM stock_logs WHERE ref_code = ? AND biz_type = ?')
      .get(refCode, bizType);
    if (dup) {
      const cur = readInv(materialId);
      return { skipped: true, reason: '该单据已记录过此类库存变动', before: cur.available, after: cur.available };
    }
  }

  // 扣减时把"检查不为负"与"写入"合成原子条件更新，防超卖
  // 发放同步释放预占；归还不触碰预占
  const released = delta < 0 ? delta : 0;
  const r = db
    .prepare(
      `UPDATE inventory
         SET available = available + ?,
             reserved   = CASE WHEN ? < 0 THEN MAX(0, reserved + ?) ELSE reserved END,
             updated_at = ?
       WHERE material_id = ? AND available + ? >= 0`
    )
    .run(delta, released, released, now(), materialId, delta);

  if (r.changes === 0) {
    const cur = readInv(materialId);
    throw new Error(`库存不足：当前可用 ${cur.available}，本次需要 ${Math.abs(delta)}`);
  }

  const after = readInv(materialId);
  db.prepare(
    'INSERT INTO stock_logs (material_id,change_qty,before_qty,after_qty,biz_type,ref_code,operator_id,remark,created_at) VALUES (?,?,?,?,?,?,?,?,?)'
  ).run(materialId, delta, after.available - delta, after.available, bizType, refCode, operatorId, remark, now());

  return { skipped: false, before: after.available - delta, after: after.available, change: delta };
}

function listStockLogs(materialId, limit = 50) {
  return db
    .prepare(
      `SELECT l.*, m.name AS material_name, m.unit, u.name AS operator_name
       FROM stock_logs l
       JOIN materials m ON m.id = l.material_id
       LEFT JOIN users u ON u.id = l.operator_id
       WHERE l.material_id = ? ORDER BY l.id DESC LIMIT ?`
    )
    .all(materialId, limit);
}

module.exports = { changeStock, reserve, release, getAvailable, getReserved, readInv, listStockLogs };
