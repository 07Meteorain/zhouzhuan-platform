// 临时校验脚本：抽取各 HTML 内联 <script> 内容做语法检查，并检查独立 js 文件
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const root = path.resolve(__dirname, "..", "frontend");
let bad = 0;

function walk(dir, out = []) {
    for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f);
        const st = fs.statSync(p);
        if (st.isDirectory()) walk(p, out);
        else out.push(p);
    }
    return out;
}

const files = walk(root);
for (const f of files) {
    if (f.endsWith(".js")) {
        try {
            new vm.Script(fs.readFileSync(f, "utf8"), { filename: f });
            console.log("OK   " + f);
        } catch (e) {
            bad++;
            console.log("FAIL " + f + " :: " + e.message);
        }
        continue;
    }
    if (!f.endsWith(".html")) continue;
    const html = fs.readFileSync(f, "utf8");
    const re = /<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g;
    let m, idx = 0;
    while ((m = re.exec(html))) {
        idx++;
        try {
            new vm.Script(m[1], { filename: f + "#" + idx });
            console.log("OK   " + f + " block" + idx);
        } catch (e) {
            bad++;
            console.log("FAIL " + f + " block" + idx + " :: " + e.message);
        }
    }
}

console.log(bad ? "\n有 " + bad + " 处语法错误" : "\n全部通过");
process.exit(bad ? 1 : 0);
