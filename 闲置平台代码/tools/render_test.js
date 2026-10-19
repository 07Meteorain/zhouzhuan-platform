// 页面渲染验证（jsdom）：真实加载每个页面并执行其脚本，抓运行时错误
// ------------------------------------------------------------------------
// 与 check_js.js（语法）/ check_dom_refs.py（引用）互补：
// 前两者证明"代码写得对"，本脚本证明"页面真能跑起来并渲染出内容"。
//
// 运行： 先启动后端 8000 与前端 3000（start.bat / start.sh）
//        node tools/render_test.js
const path = require("path");
const { JSDOM, VirtualConsole } = require(
  path.join("C:/Users/WRM/.workbuddy/binaries/node/workspace", "node_modules", "jsdom")
);

const BASE = process.env.PAIP_BASE || "http://127.0.0.1:3000";
const ACCOUNTS = {
  "index.html": null,
  "user/home.html": "user1",
  "user/publish.html": "user1",
  "user/browse.html": "user1",
  "user/records.html": "user1",
  "user/asset.html?id=1": "user1",
  "admin/orgs.html": "admin1",
  "admin/users.html": "admin1",
  "admin/assets.html": "admin1",
  "admin/logs.html": "admin1",
  "admin/stats.html": "admin1",
};

// 期望：页面加载完成后，DOM 中应出现的关键内容（用于证明真的渲染了数据）
const EXPECT = {
  "index.html": [{ text: "公共资产闲置平台" }],
  "user/home.html": [{ selector: "#dept-info", text: "智能制造学院" }],
  "user/publish.html": [{ selector: "#dept-info", text: "智能制造学院" }],
  "user/browse.html": [{ selector: "#summary", text: "共" }, { text: "多抽屉工具柜" }],
  "user/records.html": [{ selector: "#dept-info", text: "智能制造学院" }],
  "user/asset.html?id=1": [{ text: "资产编号" }, { text: "流转记录" }],
  "admin/orgs.html": [{ text: "智能制造学院" }, { text: "信息技术学院" }],
  "admin/users.html": [{ text: "user1" }, { text: "admin1" }],
  "admin/assets.html": [{ text: "图片真实性核验" }, { text: "流转记录" }],
  "admin/logs.html": [{ text: "日志中心" }],
  "admin/stats.html": [{ text: "物资总数" }, { text: "按部门统计" }],
};

let passed = 0;
let failed = 0;

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log("  [PASS] " + name);
  } else {
    failed++;
    console.log("  [FAIL] " + name + (extra ? " :: " + extra : ""));
  }
}

/** 用 Node 内置 fetch 登录拿 token（jsdom 自身不实现 fetch） */
async function login(username) {
  const resp = await fetch(BASE + "/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password: "123456" }),
  });
  const data = await resp.json();
  return data.token;
}

async function renderPage(route, username) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    // 忽略资源加载类噪音，只记录真正的脚本错误
    if (!/Could not load|Not implemented/i.test(e.message)) errors.push(e.message);
  });
  vc.on("error", (msg) => errors.push(String(msg)));

  // 取回页面 HTML 并剥离外网 CDN 脚本（Tailwind），避免测试依赖外网；
  // 本地 /js/*.js 与 /js/common.css 仍由 jsdom 通过 url 选项向站点请求。
  const resp = await fetch(BASE + "/" + route);
  const pageHtml = (await resp.text()).replace(
    /<script[^>]*cdn\.tailwindcss\.com[^>]*><\/script>/gi,
    ""
  );

  const dom = new JSDOM(pageHtml, {
    url: BASE + "/" + route,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) {
      // 注入 fetch：相对 URL 补齐为前端站点地址
      window.fetch = (input, init) => {
        const url = typeof input === "string"
          ? (input.startsWith("http") ? input : BASE + input)
          : input;
        return fetch(url, init);
      };
      if (username) {
        window.localStorage.setItem("paip_token", TOKENS[username]);
        window.localStorage.setItem(
          "paip_user",
          JSON.stringify({ username, role: username === "admin1" ? "admin" : "user" })
        );
      }
      if (!window.URL.createObjectURL) {
        window.URL.createObjectURL = () => "blob:mock";
      }
      window.print = () => {};
    },
  });

  // 给页面异步请求留出时间
  await new Promise((r) => setTimeout(r, 2500));
  const doc = dom.window.document;
  const html = doc.body.innerHTML;
  dom.window.close();
  return { errors, doc, html };
}

const TOKENS = {};

(async function main() {
  console.log("页面渲染验证（jsdom）—— 目标站点 " + BASE + "\n");

  TOKENS.user1 = await login("user1");
  TOKENS.admin1 = await login("admin1");

  for (const [route, account] of Object.entries(ACCOUNTS)) {
    console.log("[" + route + "]");
    let res;
    try {
      res = await renderPage(route, account);
    } catch (e) {
      check("页面可加载", false, e.message);
      continue;
    }
    check("脚本执行无运行时错误", res.errors.length === 0, res.errors.slice(0, 2).join(" | "));

    for (const exp of EXPECT[route] || []) {
      if (exp.selector) {
        const node = res.doc.querySelector(exp.selector);
        const ok = node && node.textContent.includes(exp.text);
        check(`${exp.selector} 含「${exp.text}」`, ok, node ? node.textContent.trim().slice(0, 60) : "节点不存在");
      } else {
        check(`页面含「${exp.text}」`, res.html.includes(exp.text));
      }
    }
    console.log("");
  }

  console.log(`===== 结果：通过 ${passed}，失败 ${failed} =====`);
  process.exit(failed === 0 ? 0 : 1);
})();
