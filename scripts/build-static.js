'use strict';
/**
 * 构建静态演示版（适配 GitHub Pages）
 *
 * 做法：
 *   1. 读取 public/index.html（原版前端，一字不改）
 *   2. 读取 scripts/mock-api.js，把 __SEED__ 替换为 scripts/seed.json 的真实台账数据
 *   3. 在页面主脚本之前注入 mock 脚本，使 window.fetch 被接管
 *   4. 额外注入演示提示条与「重置演示数据」按钮
 *   5. 输出到 docs/index.html（GitHub Pages 默认发布目录）
 *
 * 这样 GitHub Pages 上跑的是与本地完全相同的前端代码，
 * 只是把 /api/* 请求交给了浏览器内的内存数据库。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const src = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const seed = fs.readFileSync(path.join(__dirname, 'seed.json'), 'utf8');
let mock = fs.readFileSync(path.join(__dirname, 'mock-api.js'), 'utf8');

// 1. 注入种子数据
if (!mock.includes('__SEED__')) throw new Error('mock-api.js 中找不到 __SEED__ 占位符');
mock = mock.replace('__SEED__', seed.trim());

// 2. 组装注入片段
const banner = `
<div id="demoBar" class="demobar">
  <span><b>静态演示版</b> · 数据保存在浏览器本地，可完整点击申领 → 审批 → 核定 → 发放 → 归还全流程</span>
  <button class="ghost sm" onclick="DEMO.reset()">重置演示数据</button>
</div>
`;

const bannerCss = `
.demobar{background:#0f2b46;color:#cfe3f7;border-radius:10px;padding:10px 14px;margin-bottom:16px;
  display:flex;gap:12px;align-items:center;justify-content:space-between;flex-wrap:wrap;font-size:13px}
.demobar b{color:#fff}
.demobar .ghost{background:transparent;color:#cfe3f7;border-color:#3d6a94}
.demobar .ghost:hover{background:#1a4468;color:#fff}
`;

const bannerJs = `
/* 静态演示版：插入提示条 */
(function () {
  function mount() {
    if (document.getElementById('demoBar')) return;
    var w = document.querySelector('.wrap');
    if (!w) return;
    w.insertAdjacentHTML('afterbegin', document.getElementById('demoBarTpl').innerHTML);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
`;

let out = src;

// 样式
out = out.replace('</style>', bannerCss + '</style>');

// 提示条模板 + mock 脚本，放在主脚本之前
const inject = banner.replace(/\n/g, '') +
  '\n<template id="demoBarTpl">' + banner + '</template>\n' +
  '<script>' + mock + '</script>\n' +
  '<script>' + bannerJs + '</script>\n' +
  '<script>\n';

const idx = out.indexOf('<script>');
if (idx < 0) throw new Error('未找到主 <script> 标签');
out = out.slice(0, idx) + inject + out.slice(idx + '<script>'.length);

// 3. 演示模式下不依赖服务端 token 续期
out = out.replace(
  "<title>周转物资平台</title>",
  "<title>周转物资平台 · 静态演示版</title>"
);

// 校验
const vm = require('node:vm');
const checks = [
  ['mock 脚本已注入', out.includes('zz_demo_state_v1')],
  ['种子数据已注入', out.includes('"materials"')],
  ['提示条模板存在', out.includes('id="demoBarTpl"')],
  ['主脚本仍存在', out.includes('function studentView')],
  ['主脚本唯一', (out.match(/function studentView/g) || []).length === 1],
  ['script 标签配对', (out.match(/<script>/g) || []).length === (out.match(/<\/script>/g) || []).length],
  ['doctype 唯一', (out.match(/<!doctype/gi) || []).length === 1],
  ['html 标签配对', (out.match(/<html/g) || []).length === 1 && (out.match(/<\/html>/g) || []).length === 1],
];

// 逐个 script 做语法编译检查，防止注入破坏语法
const scriptBodies = [...out.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
let syntaxOk = true;
let syntaxErr = '';
scriptBodies.forEach((code, i) => {
  try { new vm.Script(code, { filename: 'script#' + i }); }
  catch (e) { syntaxOk = false; syntaxErr = 'script#' + i + '：' + e.message; }
});
checks.push(['所有 script 语法可编译' + (syntaxOk ? '' : '（' + syntaxErr + '）'), syntaxOk]);
checks.push(['script 数量为 3（mock + 提示条 + 主脚本）', scriptBodies.length === 3]);

const docsDir = path.join(ROOT, 'docs');
fs.mkdirSync(docsDir, { recursive: true });
fs.writeFileSync(path.join(docsDir, 'index.html'), out);

console.log('静态演示版已生成：docs/index.html（' + Buffer.byteLength(out) + ' 字节）\n');
let bad = 0;
for (const [name, okv] of checks) {
  console.log((okv ? '  OK   ' : '  FAIL ') + name);
  if (!okv) bad++;
}
console.log(bad === 0 ? '\n构建校验通过 ✅' : '\n' + bad + ' 项未通过 ❌');
process.exit(bad === 0 ? 0 : 1);