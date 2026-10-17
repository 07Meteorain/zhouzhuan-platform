'use strict';
/**
 * 通过 Git Data API 提交 .github/workflows 文件
 *
 * 背景：GitHub Contents API 拒绝以点开头的目录（.github/…），
 *      而 Pages legacy 构建在本仓库持续 "Page build failed"，
 *      故改用 GitHub Actions 发布，并需要单独补上 workflow 文件。
 *
 * 做法：取当前分支 commit 的 tree 作为 base_tree，追加 workflow blob，
 *      创建新 tree 与 commit，再把分支 ref 指过去。
 */
const fs = require('node:fs');
const path = require('node:path');

const TOKEN = process.argv[2];
const REPO = process.argv[3] || 'zhouzhuan-platform';
const OWNER = process.argv[4] || '07Meteorain';
const ROOT = path.join(__dirname, '..');
const API = 'https://api.github.com';

if (!TOKEN) { console.error('用法：node scripts/deploy-workflow.cjs <token> [repo] [owner]'); process.exit(1); }

const H = {
  Authorization: 'Bearer ' + TOKEN,
  Accept: 'application/vnd.github+json',
  'Content-Type': 'application/json',
  'User-Agent': 'zhouzhuan-deploy',
};

async function api(method, p, body) {
  const r = await fetch(API + p, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const txt = await r.text();
  let d = {};
  try { d = txt ? JSON.parse(txt) : {}; } catch (e) { d = { raw: txt }; }
  if (!r.ok) throw new Error(method + ' ' + p + ' -> HTTP ' + r.status + ' ' + (d.message || txt.slice(0, 200)));
  return d;
}

async function main() {
  const meta = await api('GET', '/repos/' + OWNER + '/' + REPO);
  const branch = meta.default_branch || 'main';
  console.log('仓库：' + OWNER + '/' + REPO + '，分支：' + branch);

  const ref = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/ref/heads/' + branch);
  const baseCommit = ref.object.sha;
  console.log('当前分支 commit：' + baseCommit.slice(0, 10));

  const commit = await api('GET', '/repos/' + OWNER + '/' + REPO + '/git/commits/' + baseCommit);
  const baseTree = commit.tree.sha;

  // workflow 文件 → blob
  const wfPath = '.github/workflows/pages.yml';
  const content = fs.readFileSync(path.join(ROOT, wfPath));
  const blob = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/blobs', {
    content: content.toString('base64'), encoding: 'base64',
  });
  console.log('workflow blob：' + blob.sha.slice(0, 10));

  // 在现有 tree 上追加（Git 会自动创建中间目录 tree）
  const tree = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/trees', {
    base_tree: baseTree,
    tree: [{ path: wfPath, mode: '100644', type: 'blob', sha: blob.sha }],
  });
  console.log('新 tree：' + tree.sha.slice(0, 10));

  const newCommit = await api('POST', '/repos/' + OWNER + '/' + REPO + '/git/commits', {
    message: 'ci: 改用 GitHub Actions 发布 Pages（legacy 构建在本仓库持续失败）',
    tree: tree.sha,
    parents: [baseCommit],
  });
  console.log('新 commit：' + newCommit.sha.slice(0, 10));

  await api('PATCH', '/repos/' + OWNER + '/' + REPO + '/git/refs/heads/' + branch, {
    sha: newCommit.sha, force: false,
  });
  console.log('分支已更新，Actions 已被触发');

  console.log('\n等待 Actions 部署…');
  let final = '';
  for (let i = 0; i < 30; i++) {
    await new Promise(r => setTimeout(r, 6000));
    const runs = await api('GET', '/repos/' + OWNER + '/' + REPO + '/actions/workflows/pages.yml/runs?per_page=1');
    const run = runs.workflow_runs && runs.workflow_runs[0];
    if (!run) { process.stdout.write('.'); continue; }
    process.stdout.write(run.status + '/' + run.conclusion + ' ');
    if (run.status === 'completed') { final = run.conclusion; break; }
  }
  console.log('');
  console.log('Actions 结果：' + (final || '仍在运行'));

  const url = 'https://' + OWNER.toLowerCase() + '.github.io/' + REPO + '/';
  console.log('验证网址：' + url);
  let okStatus = false, size = 0;
  for (let i = 0; i < 8; i++) {
    try {
      const r = await fetch(url, { cache: 'no-store' });
      const html = await r.text();
      size = html.length;
      console.log('  HTTP ' + r.status + '，' + size + ' 字节');
      if (r.status === 200 && html.includes('周转物资平台')) { okStatus = true; break; }
    } catch (e) { console.log('  访问失败：' + e.message); }
    await new Promise(r => setTimeout(r, 5000));
  }
  console.log('可访问：' + (okStatus ? '是 ✅' : '否 ❌'));
  process.exit(okStatus ? 0 : 1);
}

main().catch(e => { console.error('失败：' + e.message); process.exit(1); });