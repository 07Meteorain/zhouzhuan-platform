'use strict';
/**
 * HTTP 服务 —— 周转物资平台
 * 零外部依赖，直接 node server/index.js 启动
 */
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { db, now } = require('./db');
const auth = require('./auth-adapter');
const approval = require('./approval-adapter');
const inventory = require('./inventory');
const svc = require('./service');

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, '..', 'public');

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json; charset=utf-8' };

function send(res, code, data) {
  const body = JSON.stringify(data);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', () => { try { resolve(b ? JSON.parse(b) : {}); } catch (_) { resolve({}); } });
  });
}
function newToken() { return crypto.randomBytes(24).toString('hex'); }

function currentUser(req) {
  const t = (req.headers.authorization || '').replace('Bearer ', '');
  if (!t) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(t);
  if (!s) return null;
  return db.prepare('SELECT id,username,name,role,dept,phone,source FROM users WHERE id = ?').get(s.user_id);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    // ---------- 静态资源（公开，不需要登录）----------
    if (req.method === 'GET' && !p.startsWith('/api/')) {
      let fp = p === '/' ? '/index.html' : p;
      const file = path.join(PUBLIC, fp);
      if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        return res.end('404 Not Found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      return fs.createReadStream(file).pipe(res);
    }

    // ---------- 登录 ----------
    if (p === '/api/login' && req.method === 'POST') {
      const { username, password } = await readBody(req);
      const u = await auth.current.verify(username, password);
      if (!u) return send(res, 401, { error: '账号或口令不正确' });
      const token = newToken();
      db.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').run(token, u.id, now());
      return send(res, 200, { token, user: u });
    }
    if (p === '/api/logout' && req.method === 'POST') {
      const t = (req.headers.authorization || '').replace('Bearer ', '');
      db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
      return send(res, 200, { ok: true });
    }
    if (p === '/api/auth/callback' && req.method === 'GET') {
      // OA 免登回调入口（待接入）：OA 会把用户带到这里并带上 ticket
      const ticket = url.searchParams.get('ticket');
      try {
        const profile = await auth.current.verifyFromTicket?.(ticket);
        if (!profile) return send(res, 501, { error: 'OA 免登尚未接入，请设置 AUTH_MODE=oa 并配置 OA 接口' });
        const uid = auth.current.syncUser(profile);
        const token = newToken();
        db.prepare('INSERT INTO sessions (token,user_id,created_at) VALUES (?,?,?)').run(token, uid, now());
        return send(res, 200, { token, user: db.prepare('SELECT id,username,name,role,dept FROM users WHERE id=?').get(uid) });
      } catch (e) {
        return send(res, 501, { error: e.message });
      }
    }

    // 以下需要登录
    const user = currentUser(req);
    if (!user) return send(res, 401, { error: '未登录或会话已过期' });
    const deny = () => send(res, 403, { error: '无权限执行该操作' });

    if (p === '/api/me') return send(res, 200, { user, roles: svc.ROLES, authMode: auth.MODE, approvalMode: approval.MODE });

    if (p === '/api/materials' && req.method === 'GET') {
      // 按角色返回：仓库老师只看到自己负责的物资；学生/导师/管理员看到全部
      const rows = svc.listMyMaterials(user);
      return send(res, 200, rows);
    }
    if (p === '/api/materials' && req.method === 'POST') {
      // 资产管理员改绑物资负责老师
      const { id, owner_id } = await readBody(req);
      return send(res, 200, svc.assignOwner(user, id, owner_id));
    }
    if (p === '/api/warehouse/staff' && req.method === 'GET') {
      if (user.role !== 'asset_admin') return deny();
      return send(res, 200, svc.listWarehouseStaff());
    }

    if (p === '/api/requests' && req.method === 'GET') return send(res, 200, svc.listRequests(user, { stage: url.searchParams.get('stage') }));
    if (p === '/api/requests' && req.method === 'POST') {
      if (user.role !== 'student') return deny();
      return send(res, 200, svc.createRequest(user, await readBody(req)));
    }
    if (p.startsWith('/api/requests/') && req.method === 'GET') {
      return send(res, 200, svc.getRequestDetail(Number(p.split('/')[3])));
    }
    if (p === '/api/requests/mentor' && req.method === 'POST') {
      if (user.role !== 'mentor') return deny();
      const { id, pass, note } = await readBody(req);
      return send(res, 200, await svc.mentorApprove(user, Number(id), !!pass, note || ''));
    }
    if (p === '/api/requests/check' && req.method === 'POST') {
      const { id, approved_qty, note } = await readBody(req);
      return send(res, 200, await svc.warehouseCheck(user, Number(id), approved_qty, note || ''));
    }
    if (p === '/api/requests/issue' && req.method === 'POST') {
      const { id, issued_qty, deposit_note } = await readBody(req);
      return send(res, 200, svc.warehouseIssue(user, Number(id), issued_qty, deposit_note || ''));
    }
    // 学生提交归还申请（拍照，转负责老师清点）
    if (p === '/api/requests/return-submit' && req.method === 'POST') {
      const { id, declared_qty, photos } = await readBody(req);
      return send(res, 200, svc.submitReturn(user, Number(id), declared_qty, photos || []));
    }
    // 负责老师清点登记实还数量（按实还回增库存）
    if (p === '/api/requests/return' && req.method === 'POST') {
      const { id, returned_qty, photos } = await readBody(req);
      return send(res, 200, svc.returnRequest(user, Number(id), returned_qty, photos || []));
    }
    if (p === '/api/requests/close' && req.method === 'POST') {
      if (user.role !== 'asset_admin') return deny();
      const { id, note } = await readBody(req);
      return send(res, 200, svc.closeMismatch(user, Number(id), note || ''));
    }

    if (p === '/api/stock/logs') {
      return send(res, 200, inventory.listStockLogs(Number(url.searchParams.get('material_id') || 0), 100));
    }
    if (p === '/api/reconcile' && req.method === 'POST') {
      // OA 模式下的兜底：补齐丢失的回调；本地模式为空操作
      return send(res, 200, await approval.current.reconcile());
    }

    // ---------- 静态资源已在上方处理 ----------
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
  } catch (e) {
    send(res, 400, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`周转物资平台已启动`);
  console.log(`访问地址：http://localhost:${PORT}`);
  console.log(`认证模式：${auth.MODE}  审批模式：${approval.MODE}`);
  console.log('演示账号：stu001(学生) mentor01(导师) wh001(仓库) adm001(资产) 口令 demo1234');
});
