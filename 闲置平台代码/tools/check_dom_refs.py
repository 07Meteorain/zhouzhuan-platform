# -*- coding: utf-8 -*-
"""
静态一致性检查（无需浏览器）
------------------------------------------------------------------
1. getElementById("x") / PAIP.el("x") 引用的 id，必须在页面 HTML 或动态生成的
   HTML 字符串中存在（如 id="main-img"）
2. onclick="PAIP.fn()" 引用的函数必须在 window.PAIP 中定义
3. 页面引入的静态资源（/js/xxx）必须存在
4. 所有 href 指向的本地页面文件必须存在

运行： python tools/check_dom_refs.py
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"

problems = []

# 收集 PAIP 暴露的方法
common_js = (FRONTEND / "js" / "common.js").read_text(encoding="utf-8")
paip_block = common_js.split("window.PAIP = {", 1)[1].split("};", 1)[0]
paip_methods = set(re.findall(r"(\w+)\s*:", paip_block))

api_js = (FRONTEND / "js" / "api.js").read_text(encoding="utf-8")
api_block = api_js.split("window.API = {", 1)[1]
api_methods = set(re.findall(r"^\s{8}(\w+)\s*:", api_block, re.M))

for html_file in sorted(FRONTEND.rglob("*.html")):
    html = html_file.read_text(encoding="utf-8")
    rel = html_file.relative_to(ROOT).as_posix()

    # 1) 已声明的 id（含静态标签与动态字符串）
    declared_ids = set(re.findall(r'id="([^"=]+)"', html)) | set(
        re.findall(r"id=\\?['\"]([^\\'\"]+)\\?['\"]", html)
    )

    # 2) 引用的 id
    referenced = set(re.findall(r'getElementById\("([^"]+)"\)', html)) | set(
        re.findall(r'PAIP\.el\("([^"]+)"\)', html)
    )
    for rid in referenced:
        if rid not in declared_ids:
            problems.append(f"{rel}: getElementById(\"{rid}\") 找不到对应 id")

    # 3) onclick 引用的 PAIP 方法
    for fn in re.findall(r'onclick="PAIP\.(\w+)\(', html):
        if fn not in paip_methods:
            problems.append(f"{rel}: onclick PAIP.{fn} 未定义")

    # 3.1) 全脚本内 PAIP.xxx / API.xxx 调用是否都有定义
    for fn in set(re.findall(r"\bPAIP\.(\w+)\s*\(", html)):
        if fn not in paip_methods:
            problems.append(f"{rel}: 调用了未定义的 PAIP.{fn}()")
    for fn in set(re.findall(r"\bAPI\.(\w+)\s*\(", html)):
        if fn not in api_methods:
            problems.append(f"{rel}: 调用了未定义的 API.{fn}()")

    # 4) 静态资源与页面链接存在性
    for src in re.findall(r'(?:src|href)="(/[^"]+)"', html):
        if src.startswith("/api") or src.startswith("/uploads"):
            continue
        # 跳过运行时动态拼接的 URL（形如 '/user/asset.html?id=' + a.id）
        if "+" in src or "'" in src or "\\" in src:
            continue
        target = FRONTEND / src.lstrip("/")
        if not target.exists():
            problems.append(f"{rel}: 资源缺失 {src}")

if problems:
    print("发现问题：")
    for p in problems:
        print("  - " + p)
    sys.exit(1)
print("静态一致性检查通过：无缺失 id / 未定义函数 / 断链")
