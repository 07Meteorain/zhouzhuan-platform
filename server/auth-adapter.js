'use strict';
/**
 * AuthAdapter —— 身份认证适配器（预留学校 OA 接入）
 *
 * 业务代码只依赖这里暴露的 verify()，不关心身份是OA 下发还是本地登录。
 * OA 接口到位后：把 MODE 改成 'oa'，实现 OaAuth.verify() 即可，业务代码零改动。
 */
const crypto = require('node:crypto');
const { db, now } = require('./db');

const MODE = process.env.AUTH_MODE || 'local'; // local | oa

/** 本地实现：账号 + 密码（演示用，密码为账号后 6 位） */
const LocalAuth = {
  name: 'local',
  async verify(username, password) {
    const row = db.prepare('SELECT * FROM users WHERE username = ? AND active = 1').get(username);
    if (!row) return null;
    if (String(password) !== String(username).slice(-6) + '@zz') {
      // 演示环境统一口令规则：账号后6位 + @zz
      if (password !== 'demo1234') return null;
    }
    return { id: row.id, username: row.username, name: row.name, role: row.role, dept: row.dept, source: 'local' };
  },
};

/**
 * OaAuth —— 学校 OA 免登实现（待接入）
 *
 * 接入步骤：
 *  1. 向学校信息中心索取《OA 对外接口文档》与 AppKey/AppSecret
 *  2. 确认用户信息字段是否包含"部门/身份类型"（决定如何映射本平台五类角色）
 *  3. 在 OA 门户注册本应用菜单，配置免登票据透传参数
 *  4. 填入下方 CONFIG，实现 verifyFromTicket()，并把 server/index.js 里的
 *     MODE 切到 'oa'
 *
 * 预期契约（需按 OA 文档实际字段调整）：
 *  - OA 以 GET 方式把用户送到 /api/auth/callback?ticket=xxxx
 *  - 本服务用 ticket 换取用户档案，再映射成本平台角色
 */
const OA_CONFIG = {
  authUrl: process.env.OA_AUTH_URL || '',
  tokenUrl: process.env.OA_TOKEN_URL || '',
  userInfoUrl: process.env.OA_USERINFO_URL || '',
  appKey: process.env.OA_APP_KEY || '',
  appSecret: process.env.OA_APP_SECRET || '',
  callbackUrl: process.env.OA_CALLBACK_URL || '',
};

const ROLE_MAP = {
  // OA 身份字段 → 平台角色
  student: 'student',
  undergraduate: 'student',
  postgraduate: 'student',
  teacher: 'mentor',
  student_supervisor: 'mentor',
  warehouse: 'warehouse',
  asset_manager: 'asset_admin',
};

const OaAuth = {
  name: 'oa',
  config: OA_CONFIG,

  /** 校验 OA 票据并换取用户档案 */
  async verifyFromTicket(ticket) {
    if (!ticket) return null;
    if (!OA_CONFIG.appKey || !OA_CONFIG.appSecret) {
      throw new Error('OA 接入配置未完成：缺少 OA_APP_KEY / OA_APP_SECRET');
    }
    // TODO: 按 OA 文档实现"用 ticket 换 access_token"和"取用户档案"两步请求
    // const tokenRes = await fetch(OA_CONFIG.tokenUrl, { ... });
    // const info = await fetch(OA_CONFIG.userInfoUrl, { ... });
    return null;
  },

  /** 把 OA 返回的用户档案映射成本平台用户，不存在则自动落库 */
  syncUser(profile) {
    const role = ROLE_MAP[profile.identityType] || 'student';
    const exist = db.prepare('SELECT * FROM users WHERE username = ?').get(profile.username);
    if (exist) return exist.id;
    const r = db
      .prepare(
        'INSERT INTO users (username,name,role,dept,phone,source,created_at) VALUES (?,?,?,?,?,?,?)'
      )
      .run(profile.username, profile.name, role, profile.dept || '', profile.phone || '', 'oa', now());
    return Number(r.lastInsertRowid);
  },

  async verify(username, password) {
    throw new Error('OA 模式下不支持本地口令登录');
  },
};

const current = MODE === 'oa' ? OaAuth : LocalAuth;

module.exports = { current, LocalAuth, OaAuth, MODE, ROLE_MAP };
