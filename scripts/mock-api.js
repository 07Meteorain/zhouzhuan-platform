/* ============================================================
 * 周转物资平台 · 静态演示适配层
 * ------------------------------------------------------------
 * GitHub Pages 只能托管静态文件，无法运行 Node 后端。
 * 本文件在页面脚本执行前接管 window.fetch，把所有 /api/* 请求
 * 改由浏览器内的内存数据库应答，从而让同一套前端代码在纯静态
 * 环境下依然可以完整跑通业务流程。
 *
 * 实现范围与 server/service.js + server/inventory.js 保持一致：
 *   两级审批 / 部分通过改单 / 核定即预占 / 实发实还库存增减
 *   / 缺失不回增 / 负责人路由与越权拦截 / 归还两步流程
 *
 * 数据种子来自真实台账（scripts/seed.json），状态持久化在
 * localStorage，可在页面右上角一键重置。
 * ============================================================ */
(function () {
  'use strict';

  var STORE_KEY = 'zz_demo_state_v1';
  var TOKEN_KEY = 'zz_token';

  /* ---------- 内置种子（与 scripts/seed.json 保持同步） ---------- */
  var SEED = __SEED__;

  /* ---------- 状态文案 ---------- */
  var STATUS_TEXT = {
    pending_mentor: '待导师审批', pending_warehouse: '待仓库核库存', to_issue: '待发放',
    in_use: '借用中', return_submitted: '待老师清点', returned: '已归还',
    partial_closed: '部分通过已终止', rejected: '已驳回',
    mismatch: '账实不符待处理', closed: '已核销'
  };
  var ROLE_TEXT = {
    student: '学生', mentor: '导师', warehouse: '仓库老师', asset_admin: '资产管理员'
  };

  /* ---------- 工具 ---------- */
  function now() {
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      'T' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function fail(msg, code) { var e = new Error(msg); e.status = code || 400; throw e; }

  /* ---------- 初始化状态 ---------- */
  function freshState() {
    var s = { seq: 0, materials: [], requests: [], logs: [], stock: [], ownerSeq: 0 };
    // 物资：复制种子并展开库存字段
    s.materials = SEED.materials.map(function (m) {
      return {
        id: m.id, name: m.name, size: m.size || '', category: m.category || '',
        location: m.location || '', unit: m.unit || '件',
        total_qty: m.total_qty, qty_note: m.qty_note || '',
        owner_id: m.owner_id || null, available: m.available || 0, reserved: 0
      };
    });
    return s;
  }

  function load() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (raw) {
        var s = JSON.parse(raw);
        if (s && s.materials && s.materials.length) return s;
      }
    } catch (e) { /* 忽略损坏数据，回落到初始状态 */ }
    var s = freshState();
    save(s);
    return s;
  }
  function save(s) {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch (e) { /* 隐私模式下忽略 */ }
  }

  var S = load();

  /* ---------- 演示用账号（口令统一 demo1234） ---------- */
  var USERS = SEED.users.map(function (u) { return clone(u); });

  function findUser(username) {
    for (var i = 0; i < USERS.length; i++) {
      if (USERS[i].username === username) return USERS[i];
    }
    return null;
  }
  function userById(id) {
    for (var i = 0; i < USERS.length; i++) if (USERS[i].id === id) return USERS[i];
    return null;
  }
  function ownerName(m) {
    var u = m.owner_id ? userById(m.owner_id) : null;
    return u ? u.name : null;
  }
  function ownerPhone(m) {
    var u = m.owner_id ? userById(m.owner_id) : null;
    return u ? (u.phone || '') : null;
  }
  function matById(id) {
    for (var i = 0; i < S.materials.length; i++) if (S.materials[i].id === id) return S.materials[i];
    return null;
  }
  function reqById(id) {
    for (var i = 0; i < S.requests.length; i++) if (S.requests[i].id === id) return S.requests[i];
    return null;
  }

  /* ---------- 库存：唯一写入口，等价 server/inventory.js ---------- */
  function logStock(m, biz, change, remark, reqId) {
    S.stock.push({
      material_id: m.id, biz_type: biz, change_qty: change,
      before_qty: m.available, after_qty: m.available, remark: remark,
      request_id: reqId || null, created_at: now()
    });
    // 修正 after_qty（上面的写法保证 before 正确）
    S.stock[S.stock.length - 1].after_qty = m.available;
  }

  function stockMove(m, change, biz, remark, reqId) {
    var before = m.available;
    m.available = before + change;
    S.stock.push({
      material_id: m.id, biz_type: biz, change_qty: change,
      before_qty: before, after_qty: m.available,
      remark: remark, request_id: reqId || null, created_at: now()
    });
  }

  // 核定预占：可发放量 = available - reserved，条件不足直接失败（防超卖）
  function reserve(m, qty) {
    if (m.available - m.reserved < qty) fail('可发放库存不足：当前可发放 ' + (m.available - m.reserved) + ' ' + m.unit + '，需要 ' + qty);
    m.reserved += qty;
    S.stock.push({
      material_id: m.id, biz_type: 'reserve', change_qty: 0,
      before_qty: m.available, after_qty: m.available,
      remark: '核定预占 ' + qty + '（预留 →' + m.reserved + '）',
      request_id: null, created_at: now()
    });
  }
  function release(m, qty, why) {
    m.reserved = Math.max(0, m.reserved - qty);
    S.stock.push({
      material_id: m.id, biz_type: 'release', change_qty: 0,
      before_qty: m.available, after_qty: m.available,
      remark: (why || '释放预占 ') + qty + '（预留 →' + m.reserved + '）',
      request_id: null, created_at: now()
    });
  }

  /* ---------- 流转记录 ---------- */
  function log(r, action, operator, from, to, note) {
    S.logs.push({
      request_id: r.id, action: action, operator: operator ? operator.name : '系统',
      operator_name: operator ? operator.name : '系统',
      from_status: from || null, to_status: to || null,
      note: note || '', created_at: now()
    });
  }

  /* ---------- 单号 ---------- */
  function nextCode() {
    S.seq += 1;
    var d = new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return 'ZX' + d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + String(S.seq).padStart(3, '0');
  }

  /* ---------- 组装视图对象 ---------- */
  function matView(m) {
    return {
      id: m.id, name: m.name, size: m.size, category: m.category,
      location: m.location, unit: m.unit, total_qty: m.total_qty, qty_note: m.qty_note,
      owner_id: m.owner_id, owner_name: ownerName(m), owner_phone: ownerPhone(m),
      available: m.available, reserved: m.reserved
    };
  }
  function reqView(r) {
    var m = matById(r.material_id);
    var photos = null;
    try { photos = r.return_photos ? JSON.parse(r.return_photos) : []; } catch (e) { photos = []; }
    return {
      id: r.id, code: r.code, material_id: r.material_id,
      material_name: m ? m.name : '-', size: m ? m.size : '',
      material_category: m ? m.category : '', location: m ? m.location : '',
      unit: m ? m.unit : '件',
      applicant_name: r.applicant_name, applicant_no: r.applicant_no,
      borrower: r.borrower, phone: r.phone,
      owner_id: m ? m.owner_id : null, owner_name: m ? ownerName(m) : null,
      owner_phone: m ? ownerPhone(m) : null,
      apply_qty: r.apply_qty, approved_qty: r.approved_qty, issued_qty: r.issued_qty,
      returned_qty: r.returned_qty, missing_qty: r.missing_qty,
      return_declared_qty: r.return_declared_qty, return_photos: r.return_photos,
      return_photo_list: photos,
      purpose: r.purpose, use_start: r.use_start, use_end: r.use_end,
      deposit_note: r.deposit_note, status: r.status,
      status_text: STATUS_TEXT[r.status] || r.status,
      created_at: r.created_at
    };
  }

  /* ---------- 可见性 ---------- */
  function visibleReqs(user) {
    if (user.role === 'student') {
      return S.requests.filter(function (r) { return r.applicant_id === user.id; });
    }
    if (user.role === 'mentor') return S.requests.slice();
    if (user.role === 'warehouse') {
      var mine = S.materials.filter(function (m) { return m.owner_id === user.id; }).map(function (m) { return m.id; });
      return S.requests.filter(function (r) { return mine.indexOf(r.material_id) >= 0; });
    }
    return S.requests.slice(); // asset_admin 全局
  }

  // 仓库老师的待办：待核定 / 待发放 / 待清点
  function pendingFor(user) {
    if (user.role !== 'warehouse') return [];
    var mine = S.materials.filter(function (m) { return m.owner_id === user.id; }).map(function (m) { return m.id; });
    return S.requests.filter(function (r) {
      if (mine.indexOf(r.material_id) < 0) return false;
      return ['pending_warehouse', 'to_issue', 'return_submitted'].indexOf(r.status) >= 0;
    });
  }

  /* ---------- 路由处理 ---------- */
  var routes = {};

  routes['POST /api/login'] = function (path, body) {
    var u = findUser(String(body.username || '').trim());
    if (!u) fail('用户不存在：' + body.username, 401);
    if (String(body.password) !== 'demo1234') fail('口令错误（演示口令 demo1234）', 401);
    return { token: 'demo-' + u.username, user: clone(u) };
  };

  routes['GET /api/me'] = function (path, user) {
    if (!user) fail('未登录', 401);
    return {
      user: clone(user), roles: ROLE_TEXT,
      authMode: 'LocalAuth（演示）', approvalMode: 'LocalApproval（演示）'
    };
  };

  routes['GET /api/materials'] = function (path, user) {
    if (!user) fail('未登录', 401);
    if (user.role === 'warehouse') {
      return S.materials.filter(function (m) { return m.owner_id === user.id; }).map(matView);
    }
    if (user.role === 'asset_admin') return S.materials.map(matView);
    return S.materials.map(matView);
  };

  routes['POST /api/materials'] = function (path, body, user) {
    if (!user) fail('未登录', 401);
    if (user.role !== 'asset_admin') fail('仅资产管理员可调整物资负责人');
    var m = matById(Number(body.id));
    if (!m) fail('物资不存在');
    m.owner_id = Number(body.owner_id);
    save(S);
    return matView(m);
  };

  routes['GET /api/warehouse/staff'] = function (path, user) {
    if (!user) fail('未登录', 401);
    if (user.role !== 'asset_admin') fail('仅资产管理员可查看仓库老师名单');
    return USERS.filter(function (u) { return u.role === 'warehouse'; }).map(function (u) {
      return { id: u.id, name: u.name, username: u.username };
    });
  };

  routes['GET /api/requests'] = function (path, user) {
    if (!user) fail('未登录', 401);
    return visibleReqs(user).map(reqView);
  };

  routes['POST /api/requests'] = function (path, body, user) {
    if (!user) fail('未登录', 401);
    if (user.role !== 'student') fail('仅学生可提交申领');
    var m = matById(Number(body.material_id));
    if (!m) fail('物资不存在');
    var qty = Number(body.apply_qty);
    if (!Number.isInteger(qty) || qty < 1) fail('申请数量必须是 1 以上的整数');
    if (qty > m.available - m.reserved) {
      fail('可申领数量不足：当前可申请 ' + (m.available - m.reserved) + ' ' + m.unit);
    }
    var r = {
      id: S.requests.length + 1, code: nextCode(),
      material_id: m.id, applicant_id: user.id,
      applicant_name: user.name, applicant_no: user.student_no || '',
      borrower: body.borrower || user.name, phone: body.phone || user.phone || '',
      apply_qty: qty, approved_qty: null, issued_qty: null,
      returned_qty: null, missing_qty: 0,
      return_declared_qty: null, return_photos: null, return_submitted_at: null,
      purpose: body.purpose || '', use_start: body.use_start || '', use_end: body.use_end || '',
      deposit_note: body.deposit_note || '学生证抵押',
      status: 'pending_mentor', parent_id: null, created_at: now()
    };
    S.requests.push(r);
    log(r, '提交申领', user, null, 'pending_mentor', '申请 ' + qty + ' ' + m.unit);
    save(S);
    return reqView(r);
  };

  // 学生提交归还申请：不动库存
  routes['POST /api/requests/return-submit'] = function (path, body, user) {
    if (!user) fail('未登录', 401);
    var r = reqById(Number(body.id));
    if (!r) fail('单据不存在');
    if (r.applicant_id !== user.id) fail('只能为自己借用的物资提交归还');
    if (r.status !== 'in_use') fail('当前状态不可提交归还');
    var qty = Number(body.declared_qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > r.issued_qty) {
      fail('申报数量必须是 0 ~ ' + r.issued_qty + ' 之间的整数');
    }
    var photos = body.photos || [];
    if (!Array.isArray(photos) || !photos.length) fail('请至少上传一张归还照片作为凭证');
    r.return_declared_qty = qty;
    r.return_photos = JSON.stringify(photos);
    r.return_submitted_at = now();
    r.status = 'return_submitted';
    log(r, '学生提交归还申请', user, 'in_use', 'return_submitted',
      '申报归还 ' + qty + '，已上传凭证 ' + photos.length + ' 张；等待负责老师清点');
    save(S);
    return reqView(r);
  };

  // 导师审批
  routes['POST /api/requests/mentor'] = function (path, body, user) {
    if (!user) fail('未登录', 401);
    if (user.role !== 'mentor') fail('仅导师可审批');
    var r = reqById(Number(body.id));
    if (!r) fail('单据不存在');
    if (r.status !== 'pending_mentor') fail('当前状态不可审批');
    if (body.pass) {
      r.status = 'pending_warehouse';
      log(r, '导师通过', user, 'pending_mentor', 'pending_warehouse', body.note || '');
    } else {
      r.status = 'rejected';
      log(r, '导师驳回', user, 'pending_mentor', 'rejected', body.note || '未说明原因');
    }
    save(S);
    return reqView(r);
  };

  // 负责老师核定：核定即预占；小于申请数则生成改单
  routes['POST /api/requests/check'] = function (path, body, user) {
    if (!user) fail('未登录', 401);
    if (user.role !== 'warehouse') fail('仅仓库老师可核定');
    var r = reqById(Number(body.id));
    if (!r) fail('单据不存在');
    var m = matById(r.material_id);
    if (m.owner_id !== user.id) {
      fail('该物资由「' + (ownerName(m) || '未绑定') + '」负责，无权操作此单');
    }
    if (r.status !== 'pending_warehouse') fail('当前状态不可核定');
    var qty = Number(body.approved_qty);
    if (!Number.isInteger(qty) || qty < 0) fail('核定数量必须是非负整数');

    if (qty === r.apply_qty) {
      reserve(m, qty);
      r.approved_qty = qty;
      r.status = 'to_issue';
      log(r, '仓库核定', user, 'pending_warehouse', 'to_issue', '完全通过，核定 ' + qty + ' ' + m.unit + '，库存已预占');
      save(S);
      return reqView(r);
    }

    // 部分通过：原单终止，预占额度转交改单
    var created = {
      id: S.requests.length + 1, code: nextCode(),
      material_id: m.id, applicant_id: r.applicant_id,
      applicant_name: r.applicant_name, applicant_no: r.applicant_no,
      borrower: r.borrower, phone: r.phone,
      apply_qty: qty, approved_qty: null, issued_qty: null,
      returned_qty: null, missing_qty: 0,
      return_declared_qty: null, return_photos: null, return_submitted_at: null,
      purpose: r.purpose, use_start: r.use_start, use_end: r.use_end,
      deposit_note: r.deposit_note,
      status: 'pending_mentor', parent_id: r.id, created_at: now()
    };
    reserve(m, qty);
    r.approved_qty = qty;
    r.status = 'partial_closed';
    log(r, '仓库核定（部分通过）', user, 'pending_warehouse', 'partial_closed',
      '核定 ' + qty + ' / 申请 ' + r.apply_qty + ' ' + m.unit + '，已生成改单 ' + created.code);
    S.requests.push(created);
    log(created, '部分通过改单生成', user, null, 'pending_mentor',
      '由 ' + r.code + ' 部分通过转入，核定上限 ' + qty + ' ' + m.unit);
    save(S);
    return { request: reqView(r), created: reqView(created) };
  };

  // 发放：按实发扣库存，多余预占释放
  routes['POST /api/requests/issue'] = function (path, body, user) {
    if (!user) fail('未登录', 401);
    if (user.role !== 'warehouse') fail('仅仓库老师可发放');
    var r = reqById(Number(body.id));
    if (!r) fail('单据不存在');
    var m = matById(r.material_id);
    if (m.owner_id !== user.id) {
      fail('该物资由「' + (ownerName(m) || '未绑定') + '」负责，无权操作此单');
    }
    if (r.status !== 'to_issue') fail('当前状态不可发放');
    var qty = Number(body.issued_qty);
    if (!Number.isInteger(qty) || qty < 1) fail('实发数量必须大于 0');
    if (qty > r.approved_qty) fail('实发数量不能超过核定数量 ' + r.approved_qty);
    if (qty > m.available - (m.reserved - r.approved_qty)) fail('库存不足，无法发放');
    release(m, r.approved_qty, '部分通过改单，预占额度转交改单');
    stockMove(m, -qty, 'issue', '发放给' + r.applicant_name + ' ' + qty + m.unit, r.id);
    r.issued_qty = qty;
    r.deposit_note = body.deposit_note || r.deposit_note;
    r.status = 'in_use';
    log(r, '发放', user, 'to_issue', 'in_use', '实发 ' + qty + ' ' + m.unit + '，库存按实发扣减');
    save(S);
    return reqView(r);
  };

  // 老师清点登记：以实还为准回增库存，差额标记缺失不回增
  routes['POST /api/requests/return'] = function (path, body, user) {
    if (!user) fail('未登录', 401);
    if (user.role !== 'warehouse') fail('仅仓库老师可登记归还');
    var r = reqById(Number(body.id));
    if (!r) fail('单据不存在');
    var m = matById(r.material_id);
    if (m.owner_id !== user.id) {
      fail('该物资由「' + (ownerName(m) || '未绑定') + '」负责，无权操作此单');
    }
    if (['in_use', 'return_submitted'].indexOf(r.status) < 0) fail('当前状态不可归还');
    var photos = [];
    if (r.return_photos) { try { photos = JSON.parse(r.return_photos); } catch (e) { photos = []; } }
    if (body.photos && body.photos.length) photos = body.photos;
    if (!photos.length) fail('请上传至少一张归还照片作为凭证');

    var qty = Number(body.returned_qty);
    if (!Number.isInteger(qty) || qty < 0 || qty > r.issued_qty) {
      fail('实还数量必须是 0 ~ ' + r.issued_qty + ' 之间的整数');
    }
    stockMove(m, qty, 'return', '归还 ' + qty + m.unit, r.id);
    r.returned_qty = qty;
    r.missing_qty = r.issued_qty - qty;
    r.return_photos = JSON.stringify(photos);
    if (r.return_declared_qty != null && r.return_declared_qty !== qty) {
      r.status = 'mismatch';
      log(r, '老师清点（账实不符）', user, r.status === 'mismatch' ? 'return_submitted' : 'in_use', 'mismatch',
        '学生申报 ' + r.return_declared_qty + '，实际清点 ' + qty + '，缺失 ' + r.missing_qty + ' ' + m.unit + ' 转入学校物资丢失流程');
    } else {
      r.status = 'returned';
      log(r, '老师清点', user, 'return_submitted', 'returned', '归还 ' + qty + ' ' + m.unit + '，账实相符');
    }
    save(S);
    return reqView(r);
  };

  // 资产管理员核销
  routes['POST /api/requests/close'] = function (path, body, user) {
    if (!user) fail('未登录', 401);
    if (user.role !== 'asset_admin') fail('仅资产管理员可核销');
    var r = reqById(Number(body.id));
    if (!r) fail('单据不存在');
    if (r.status !== 'mismatch') fail('当前状态不可核销');
    r.status = 'closed';
    log(r, '资产管理员核销', user, 'mismatch', 'closed', body.note || '');
    save(S);
    return reqView(r);
  };

  // 详情：附流转记录与库存流水
  routes['GET /api/requests/detail'] = function (path, user, query) {
    if (!user) fail('未登录', 401);
    var r = reqById(Number(query.id));
    if (!r) fail('单据不存在');
    if (user.role === 'student' && r.applicant_id !== user.id) fail('无权查看此单据');
    if (user.role === 'warehouse') {
      var m = matById(r.material_id);
      if (m.owner_id !== user.id) fail('该单据不属于您负责的物资');
    }
    var d = reqView(r);
    d.logs = S.logs.filter(function (l) { return l.request_id === r.id; });
    d.stock_logs = S.stock.filter(function (l) { return l.request_id === r.id; });
    return d;
  };

  /* ---------- fetch 拦截 ---------- */
  var realFetch = window.fetch.bind(window);

  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input.url;
    var path = url.replace(/^https?:\/\/[^/]+/, '').split('?')[0];
    if (path.indexOf('/api/') !== 0) return realFetch(input, init);

    var opt = init || {};
    var method = (opt.method || 'GET').toUpperCase();
    var body = {};
    if (opt.body) { try { body = JSON.parse(opt.body); } catch (e) { body = {}; } }

    var token = null;
    if (opt.headers && opt.headers.Authorization) {
      token = String(opt.headers.Authorization).replace(/^Bearer\s+/i, '');
    }
    var user = null;
    if (token && token.indexOf('demo-') === 0) user = findUser(token.slice(5));
    if (!user && method === 'POST' && path === '/api/login') user = null;

    return new Promise(function (resolve) {
      setTimeout(function () {
        var key = method + ' ' + path;
        var handler = routes[key];
        try {
          if (path.indexOf('/api/requests/') === 0 && method === 'GET') {
            // /api/requests/{id} → 复用详情处理器
            var id = decodeURIComponent(path.slice('/api/requests/'.length));
            var d = routes['GET /api/requests/detail'](path, user, { id: id });
            return resolve({ ok: true, status: 200, json: function () { return Promise.resolve(d); } });
          }
          if (path === '/api/logout') {
            return resolve({ ok: true, status: 200, json: function () { return Promise.resolve({ ok: true }); } });
          }
          if (!handler) {
            return resolve({
              ok: false, status: 404,
              json: function () { return Promise.resolve({ error: '静态演示版未实现该接口：' + key }); }
            });
          }
          // POST 处理器签名为 (path, body, user)，GET 处理器签名为 (path, user, query)
          var data = (method === 'GET') ? handler(path, user, {}) : handler(path, body, user);
          resolve({ ok: true, status: 200, json: function () { return Promise.resolve(data); } });
        } catch (e) {
          resolve({
            ok: false, status: e.status || 400,
            json: function () { return Promise.resolve({ error: e.message }); }
          });
        }
      }, 60); // 轻微延迟，保留真实网络请求的手感
    });
  };

  /* ---------- 供页面调用的演示辅助 ---------- */
  window.DEMO = {
    reset: function () {
      localStorage.removeItem(STORE_KEY);
      localStorage.removeItem(TOKEN_KEY);
      location.reload();
    },
    snapshot: function () { return S; }
  };
})();