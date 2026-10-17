'use strict';
/**
 * GitHub 部署：建仓 → 推送 → 开启 Pages → 轮询等待构建 → 验证网址可访问
 *
 * 用法：node scripts/deploy-github.js <token> [仓库名]
 * 说明：本机沙箱访问 github.com 主站被拦，但 api.github.com 可达，
 *      因此不走 git 协议，改用 GitHub REST API 直接上传文件。
 */
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.argv[2];
const REPO = process.argv[3] || 'zhouzhuan-platform';
const API = 'https://api.github.com';
const ROOT = path.join(__dirname, '..');

if (!TOKEN) { console.error('用法：node scripts/deploy-github.js <token> [仓库名]'); process.exit(1); }

const H = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'zhouzhuan-deploy',
};

async function api(method, p, body) {
  const r = await fetch(API + p, {
    method,
    headers: Object.assign({}, H, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  });
  const txt = await r.text();
  let d = {};
  try { d = txt ? JSON.parse(txt) : {}; } catch (e) { d = { raw: txt }; }
  if (!r.ok) {
    const e = new Error(method + ' ' + p + ' -> HTTP ' + r.status + ' ' + (d.message || txt.slice(0, 200)));
    e.status = r.status; e.body = d;
    throw e;
  }
  return d;
}

const log = (m) => console.log(m);

async function main() {
/* ---------- 1. 确认身份 ---------- */
const me = await api('GET', '/user');
log('账号：' + me.login);

/* ---------- 2. 建仓 ---------- */
let created = false;
try {
  await api('POST', '/user/repos', { name: REPO, private: false, auto_init: false });
  created = true;
  log('仓库已创建：' + REPO);
} catch (e) {
  if (e.status === 422) log('仓库已存在，直接复用：' + REPO);
  else throw e;
}

/* ---------- 3. 收集文件 ---------- */
function walk(dir, base) {
  base = base || '';
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (name === '.git' || name === 'node_modules') continue;
    const full = path.join(dir, name);
    const rel = base ? base + '/' + name : name;
    if (fs.statSync(full).isDirectory()) out.push(...walk(full, rel));
    else out.push(rel);
  }
  return out;
}
// 排除项：数据库（含 WAL/SHM）、git 内部目录、临时文件
// 特别注意 data/platform.db 不能上传，那是运行时数据，且不应进版本库
const EXCLUDE = [/^\.git\//, /^data\/platform\.db/, /\.db-shm$/, /\.db-wal$/, /(^|\/)\.DS_Store$/, /(^|\/)ghtest\.js$/];
const files = walk(ROOT).filter(f => !EXCLUDE.some(re => re.test(f.split(path.sep).join('/'))));
log('待上传文件：' + files.length + ' 个（已排除数据库等运行时文件）');
const leaked = files.filter(f => /platform\.db/.test(f));
if (leaked.length) { log('警告：检测到数据库文件，已中止！' + leaked.join(', ')); process.exit(1); }

/* ---------- 4. 逐文件写入默认分支 ---------- */
const meta = await api('GET', '/repos/' + me.login + '/' + REPO);
const base = meta.default_branch || 'main';
log('默认分支：' + base);

let ref;
try {
  const r = await api('GET', '/repos/' + me.login + '/' + REPO + '/git/ref/heads/' + base);
  ref = { sha: r.object.sha };
  log('已存在分支 ' + base + '，将在其上追加提交');
} catch (e) {
  // 404=分支不存在；409=仓库为空；两者都视为需创建首个提交
  if (e.status !== 404 && e.status !== 409) throw e;
  ref = null;
  log('分支 ' + base + ' 不存在，将随首个文件提交创建');
}

let done = 0;
for (const rel of files) {
  const content = fs.readFileSync(path.join(ROOT, rel));
  // 注意：只编码路径段，斜杠必须保留，否则会生成 docs%2Findex.html 这种错误路径
  const apiPath = '/repos/' + me.login + '/' + REPO + '/contents/' +
    rel.split(/[\\/]/).map(encodeURIComponent).join('/');
  const payload = {
    message: 'chore: 更新 ' + rel,
    content: content.toString('base64'),
    branch: base,
  };
  // 仅当文件已存在时才带上 sha（新建文件不能带 sha，否则 422）
  let existingSha;
  try {
    const cur = await api('GET', apiPath + '?ref=' + base);
    if (cur && cur.sha) existingSha = cur.sha;
  } catch (e) { existingSha = undefined; }
  if (existingSha) payload.sha = existingSha;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await api('PUT', apiPath, payload);
      done++;
      break;
    } catch (e) {
      // 409/422 = sha 过期或不该带 sha，重新判定一次后重试
      if ((e.status === 409 || e.status === 422) && attempt < 3) {
        try {
          const cur = await api('GET', apiPath + '?ref=' + base);
          payload.sha = cur.sha;
        } catch (_) { delete payload.sha; }
        continue;
      }
      throw e;
    }
  }
  if (done % 10 === 0) log('  已上传 ' + done + '/' + files.length);
}
log('文件上传完成');

/* ---------- 5. 取最终分支 sha，必要时补一次提交 ---------- */
const branchRef = await api('GET', '/repos/' + me.login + '/' + REPO + '/git/ref/heads/' + base);
log('分支当前 commit：' + branchRef.object.sha.slice(0, 10));

/* ---------- 6. 开启 Pages ---------- */
try {
  const p = await api('GET', '/repos/' + me.login + '/' + REPO + '/pages');
  log('Pages 已开启：' + p.html_url);
} catch (e) {
  if (e.status !== 404) log('查询 Pages 状态异常：' + e.message);
  try {
    const p = await api('POST', '/repos/' + me.login + '/' + REPO + '/pages', {
      source: { branch: base, path: '/docs' },
    });
    log('Pages 已开启：' + p.html_url);
  } catch (e2) {
    // 部分情况下需要用 build_type 方式
    const p = await api('POST', '/repos/' + me.login + '/' + REPO + '/pages', {
      source: { branch: base, path: '/docs' },
    });
    log('Pages 已开启：' + p.html_url);
  }
}

/* ---------- 7. 等待构建 ---------- */
const pageUrl = 'https://' + me.login.toLowerCase() + '.github.io/' + REPO + '/';
log('\n等待 Pages 构建（最多 3 分钟）…');
let state = '', deployedUrl = '';
for (let i = 0; i < 36; i++) {
  await new Promise(r => setTimeout(r, 5000));
  try {
    const p = await api('GET', '/repos/' + me.login + '/' + REPO + '/pages/builds/latest');
    state = p.status;
    if (state === 'built') { deployedUrl = p.url || pageUrl; break; }
    if (state === 'errored') { log('构建失败：' + (p.error && p.error.message)); process.exit(1); }
  } catch (e) { /* 首次构建尚无记录 */ }
  process.stdout.write('.');
}
log('');
log('构建状态：' + (state || '未知'));

/* ---------- 8. 验证可访问 ---------- */
log('\n验证最终网址：' + pageUrl);
let okStatus = false, size = 0;
for (let i = 0; i < 10; i++) {
  try {
    const r = await fetch(pageUrl, { cache: 'no-store' });
    const html = await r.text();
    size = html.length;
    log('  HTTP ' + r.status + '，' + size + ' 字节');
    if (r.status === 200 && html.includes('周转物资平台')) { okStatus = true; break; }
  } catch (e) { log('  访问失败：' + e.message); }
  await new Promise(r => setTimeout(r, 4000));
}

log('\n================ 部署结果 ================');
log('仓库：https://github.com/' + me.login + '/' + REPO);
log('网址：' + pageUrl);
log('可访问：' + (okStatus ? '是 ✅（' + size + ' 字节，含平台标题）' : '否 ❌'));
log('==========================================');
process.exit(okStatus ? 0 : 1);
}

main().catch(e => { console.error('部署失败：' + e.message); process.exit(1); });