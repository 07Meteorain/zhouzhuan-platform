'use strict';
/** 前端体检：JS 语法检查 + 隐式全局变量依赖扫描 + 残留引用检查 */
const fs = require('node:fs');
const path = require('node:path');

const file = path.join(__dirname, '..', 'public', 'index.html');
const html = fs.readFileSync(file, 'utf8');
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) { console.error('未找到 <script> 块'); process.exit(1); }
const js = m[1];

let bad = 0;

// 1. 语法
try {
  new Function(js);
  console.log('[1] JS 语法           OK');
} catch (e) {
  console.log('[1] JS 语法           FAIL -> ' + e.message);
  bad++;
}

// 2. 残留的已删除函数（只查"调用点"，不查局部变量声明）
for (const name of ['loadMats', 'loadMyMats']) {
  const called = new RegExp(`\\b${name}\\s*\\(`).test(js);
  if (called) { console.log(`[2] 残留调用 ${name.padEnd(10)} FAIL`); bad++; }
}
// 已删除的 DOM 容器不应再出现在 HTML 里
for (const id of ['matCards', 'myMats']) {
  if (html.includes(`id="${id}"`)) { console.log(`[2] 残留容器 #${id.padEnd(9)} FAIL`); bad++; }
}
if (bad === 0) console.log('[2] 残留引用           OK');

// 3. 隐式全局变量（id 当变量用）——这类在部分环境会失效
const ids = [...html.matchAll(/\bid="([a-zA-Z_][\w]*)"/g)].map((x) => x[1]);
const risky = ids.filter((id) => {
  const usedAsVar = new RegExp(`(^|[^.\w'"\`])${id}\\s*[.=]`).test(js) ||
                    new RegExp(`\\b${id}\\s*\\.value`).test(js);
  if (!usedAsVar) return false;
  // 若已显式 document.getElementById 或 const $ 包装，则不算风险
  return !js.includes(`document.getElementById('${id}')`) && !js.includes(`const $ =`);
});
if (risky.length) {
  console.log('[3] 隐式全局依赖      WARN -> ' + risky.join(', '));
} else {
  console.log('[3] 隐式全局依赖      OK');
}

// 4. 关键 DOM id 是否都存在
const must = ['aMat', 'aOwner', 'applyBox', 'aQty', 'view'];
const missing = must.filter((id) => !html.includes(`id="${id}"`));
console.log(`[4] 关键 DOM id        ${missing.length ? 'FAIL 缺: ' + missing.join(',') : 'OK'}`);
if (missing.length) bad++;

console.log(bad === 0 ? '\n前端体检通过 ✅' : `\n发现 ${bad} 项问题 ❌`);
process.exit(bad === 0 ? 0 : 1);