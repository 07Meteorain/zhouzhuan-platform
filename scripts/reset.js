'use strict';
/**
 * 重置演示数据：清空单据与流水，库存恢复初始值，保留物资与账号
 * 用法：node scripts/reset.js
 */
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'platform.db'));

db.exec(`
  DELETE FROM stock_logs;
  DELETE FROM request_logs;
  DELETE FROM requests;
  DELETE FROM sessions;
  UPDATE inventory SET available = (SELECT total_qty FROM materials m WHERE m.id = inventory.material_id), reserved = 0;
`);
const n = db.prepare('SELECT COUNT(*) AS c FROM requests').get();
console.log('演示数据已重置，单据数 =', n.c, '库存已恢复初始值');
