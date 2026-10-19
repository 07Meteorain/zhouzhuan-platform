# -*- coding: utf-8 -*-
"""
端到端冒烟测试（本地，无需 Docker）
------------------------------------------------------------------
启动后端 -> 走通：登录 → 发布（含图片上传）→ 浏览 → 搜索 → 认领扣减
→ 归零自动下架 → 流转记录 → 交接单 → 我的记录 → 管理员四个模块。

运行： python tools/smoke_test.py
"""
import io
import json
import os
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
TMP = ROOT / "tools" / ("_runtime_" + str(int(time.time())))

PORT = 8123
BASE = f"http://127.0.0.1:{PORT}"
DB = TMP / "app.db"
UPLOADS = TMP / "uploads"

passed = 0
failed = 0


def check(name, cond, extra=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  [PASS] {name}")
    else:
        failed += 1
        print(f"  [FAIL] {name} {extra}")


def req(method, path, token=None, body=None, form=None):
    url = BASE + path
    data = None
    headers = {}
    if token:
        headers["Authorization"] = "Bearer " + token
    if form is not None:
        data = form
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            raw = resp.read().decode("utf-8")
            return resp.status, (json.loads(raw) if raw else None)
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw) if raw else None
        except Exception:
            return e.code, {"detail": raw}


def req_raw(method, path, token=None, body=None):
    """原始请求：用于 CSV / docx / pdf 这类非 JSON 响应，返回 (状态码, 字节内容)"""
    url = BASE + path
    headers = {}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    if token:
        headers["Authorization"] = "Bearer " + token
    r = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(r, timeout=60) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()


def build_multipart(fields, files):
    """构造 multipart/form-data 请求体"""
    boundary = "----paipBoundary7MA4YWxk"
    buf = io.BytesIO()
    for k, v in fields.items():
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(f'Content-Disposition: form-data; name="{k}"\r\n\r\n'.encode())
        buf.write(str(v).encode("utf-8") + b"\r\n")
    for field_name, filename, content in files:
        buf.write(f"--{boundary}\r\n".encode())
        buf.write(
            f'Content-Disposition: form-data; name="{field_name}"; filename="{filename}"\r\n'.encode()
        )
        buf.write(b"Content-Type: application/octet-stream\r\n\r\n")
        buf.write(content + b"\r\n")
    buf.write(f"--{boundary}--\r\n".encode())
    return buf.getvalue(), f"multipart/form-data; boundary={boundary}"


def make_unique_png(seed=None):
    """
    生成一张"唯一"的 PNG 测试图（随机噪点，保证 sha256 不与库内图片重复）。
    满足后端图片真实性门槛：边长 ≥ 200px、文件 ≥ 5KB、可被 Pillow 正确解码。
    """
    from PIL import Image

    import random

    rnd = random.Random(seed if seed is not None else time.time())
    img = Image.new("RGB", (320, 240))
    px = img.load()
    for x in range(320):
        for y in range(240):
            px[x, y] = (rnd.randint(0, 255), rnd.randint(0, 255), rnd.randint(0, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def post_asset(token, fields, files):
    data, ctype = build_multipart(fields, files)
    r = urllib.request.Request(BASE + "/api/assets", data=data, method="POST")
    r.add_header("Content-Type", ctype)
    r.add_header("Authorization", "Bearer " + token)
    try:
        with urllib.request.urlopen(r, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"detail": raw}


def login(u, p):
    st, data = req("POST", "/api/auth/login", body={"username": u, "password": p})
    assert st == 200, f"登录失败 {u}: {data}"
    return data["token"], data["user"]


def main():
    global passed, failed
    if TMP.exists():
        shutil.rmtree(TMP)
    TMP.mkdir(parents=True)
    UPLOADS.mkdir(parents=True)

    env = dict(os.environ)
    env.update(
        {
            "DATABASE_PATH": str(DB),
            "UPLOAD_DIR": str(UPLOADS),
            "SEED_SCRIPT": str(ROOT / "database" / "seed.py"),
            "SEED_IMAGE_DIR": str(ROOT / "database" / "seed_images"),
            "SECRET_KEY": "smoke-test-secret",
            "PYTHONPATH": str(BACKEND),
        }
    )

    print("[1] 启动后端服务...")
    proc = subprocess.Popen(
        [
            sys.executable,
            "-m",
            "uvicorn",
            "app.main:app",
            "--host",
            "127.0.0.1",
            "--port",
            str(PORT),
            "--log-level",
            "warning",
        ],
        cwd=str(BACKEND),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )

    try:
        # 等待服务就绪
        ok = False
        for _ in range(60):
            try:
                with urllib.request.urlopen(BASE + "/api/health", timeout=5) as resp:
                    if resp.status == 200:
                        ok = True
                        break
            except Exception:
                time.sleep(1)
        if not ok:
            out = proc.stdout.read().decode("utf-8", errors="ignore") if proc.stdout else ""
            print("后端启动失败：\n" + out)
            return 1

        print("\n[2] 登录与会话")
        t1, u1 = login("user1", "123456")
        check("user1 登录成功并显示学院+部门", u1["dept_full_name"] == "智能制造学院 / 实训中心", u1)
        t2, u2 = login("user2", "123456")
        check("user2 登录成功", u2["dept_full_name"] == "信息技术学院 / 网络运维部", u2)
        ta, ua = login("admin1", "123456")
        check("admin1 登录成功（管理员）", ua["role"] == "admin", ua)
        st, _ = req("GET", "/api/auth/me")
        check("未带 token 访问受保护接口返回 401", st == 401)

        print("\n[3] 种子数据校验")
        st, colleges = req("GET", "/api/colleges", t1)
        check("2 个专业学院", len(colleges) == 2, colleges)
        check("每个学院 2 个下设部门", all(len(c["departments"]) == 2 for c in colleges))
        st, assets = req("GET", "/api/assets", t1)
        check("3 条已上架物资", len([a for a in assets if a["status"] == "on"]) == 3, len(assets))
        check("1 条已被领走自动下架（ZC-2026-004）",
              any(a["asset_no"] == "ZC-2026-004" and a["status"] == "off" for a in assets))
        st, claims = req("GET", "/api/claims", ta)
        check("1 条已完成认领流转记录", len(claims) == 1, claims)
        check("流转记录带交接单号", bool(claims[0]["handover_no"]))

        print("\n[4] 发布物资（两级联动 + 编号唯一 + 图片真实性）")
        seed_img = ROOT / "database" / "seed_images" / "手动液压堆高车.png"
        raw = seed_img.read_bytes()
        # 伪造一张与已有图片内容完全相同的图，应被指纹查重拒绝
        st, res = post_asset(t1, {
            "asset_no": "ZC-2026-101", "name": "测试物资", "category": "测试分类",
            "unit": "套", "spec": "100×100", "total_count": 3, "condition_desc": "全新",
            "remark": "", "using_person": "测试", "usage_direction": "测试",
            "manage_dept": "测试部", "location": "测试楼", "contact_person": "测试",
            "contact_emp_no": "99999", "contact_phone": "13800000000",
            "college_id": u1["college_id"], "department_id": u1["department_id"],
            "cover_index": 0, "captions": "[]",
        }, [("files", "dup.png", raw)])
        check("重复图片被拒绝（禁止盗图/网图）", st == 400, res)

        # 非图片文件应被拒绝
        st, res = post_asset(t1, {
            "asset_no": "ZC-2026-102", "name": "测试物资", "total_count": 1,
            "college_id": u1["college_id"], "department_id": u1["department_id"],
            "cover_index": 0, "captions": "[]",
        }, [("files", "fake.png", b"this is not an image")])
        check("非图片文件被拒绝（文件头校验）", st == 400, res)

        # 正常发布：伪造一张"新"的真实 PNG（给像素加随机扰动）
        from PIL import Image

        im = Image.open(seed_img).convert("RGB")
        w, h = im.size
        px = im.load()
        for i in range(0, w, 37):
            for j in range(0, h, 37):
                r, g, b = px[i, j]
                px[i, j] = ((r + 3) % 256, (g + 5) % 256, (b + 7) % 256)
        out = io.BytesIO()
        im.save(out, format="PNG")
        new_png = out.getvalue()

        st, asset1 = req("POST", "/api/assets", t1, form=None) if False else post_asset(t1, {
            "asset_no": "ZC-2026-101", "name": "测试物资A", "category": "测试分类",
            "unit": "套", "spec": "100×100×50mm", "total_count": 3, "condition_desc": "九成新",
            "remark": "冒烟测试", "using_person": "王测试", "usage_direction": "教学",
            "manage_dept": "测试管理部门", "location": "测试楼 A101", "contact_person": "王测试",
            "contact_emp_no": "99999", "contact_phone": "13800000000",
            "college_id": u1["college_id"], "department_id": u1["department_id"],
            "cover_index": 0, "captions": json.dumps(["整体照片"]),
        }, [("files", "test_a.png", new_png)])
        check("发布成功且直接上架", st == 200 and asset1.get("status") == "on", asset1)
        check("发布后剩余=总数", asset1.get("remaining_count") == 3, asset1)
        check("图片已入库并设为首图",
              bool(asset1.get("images")) and asset1["images"][0]["is_cover"] is True, asset1)

        st, res = post_asset(t1, {
            "asset_no": "ZC-2026-101", "name": "重复编号", "total_count": 1,
            "college_id": u1["college_id"], "department_id": u1["department_id"],
            "cover_index": 0, "captions": "[]",
        }, [("files", "test_b.png", new_png)])
        check("资产编号重复被拒绝", st == 400, res)

        st, res = post_asset(t1, {
            "asset_no": "ZC-2026-103", "name": "电话格式错误", "total_count": 1,
            "contact_phone": "123", "contact_emp_no": "99999",
            "college_id": u1["college_id"], "department_id": u1["department_id"],
            "cover_index": 0, "captions": "[]",
        }, [("files", "test_c.png", new_png)])
        check("电话格式错误被拒绝", st == 400, res)

        # 学院 / 部门联动无效
        st, res = post_asset(t1, {
            "asset_no": "ZC-2026-104", "name": "联动错误", "total_count": 1,
            "contact_phone": "13800000000", "contact_emp_no": "99999",
            "college_id": u1["college_id"], "department_id": 99999,
            "cover_index": 0, "captions": "[]",
        }, [("files", "test_d.png", new_png)])
        check("学院/部门联动无效被拒绝", st == 400, res)

        print("\n[5] 浏览与搜索")
        st, assets = req("GET", "/api/assets", t1)
        check("新发布物资出现在平台浏览列表", any(a["asset_no"] == "ZC-2026-101" for a in assets))
        st, res = req("GET", "/api/assets?keyword=%E5%BA%8A", t1)  # 床
        check("按名称搜索命中 1 条", st == 200 and len(res) == 1, res)
        st, res = req("GET", "/api/assets?keyword=ZC-2026-101", t1)
        check("按编号搜索命中 1 条", st == 200 and len(res) == 1, res)
        st, res = req("GET", "/api/assets?location=%E4%BF%A1%E6%81%AF%E6%A5%BC", t1)  # 信息楼
        check("按存放地点搜索有结果", st == 200 and len(res) >= 1, res)
        st, res = req("GET", "/api/assets?category=%E6%90%AC%E8%BF%90%E8%AE%BE%E5%A4%87", t1)  # 搬运设备
        check("按分类搜索有结果", st == 200 and len(res) >= 1, res)

        st, detail = req("GET", f"/api/assets/{asset1['id']}", t1)
        check("详情含全部字段（使用人/使用方向/管理部门等）",
              all(k in detail for k in ["using_person", "usage_direction", "manage_dept", "spec", "condition_desc"]),
              list(detail.keys()))
        check("详情页含流转记录字段", "transfers" in detail)

        print("\n[6] 认领扣减 / 归零自动下架 / 流转记录")
        st, res = req("POST", "/api/claims", t2, body={
            "asset_id": asset1["id"], "quantity": 99,
            "receiver_name": "赵强", "receiver_emp_no": "30208", "receiver_phone": "13800000004",
        })
        check("超剩余认领被拒绝", st == 400, res)

        st, res = req("POST", "/api/claims", t2, body={
            "asset_id": asset1["id"], "quantity": 1,
            "receiver_name": "赵强", "receiver_emp_no": "30208", "receiver_phone": "13800000004",
            "remark": "先领 1 套",
        })
        check("认领 1 套成功", st == 200 and res["asset"]["remaining_count"] == 2, res)

        st, res = req("POST", "/api/claims", t2, body={
            "asset_id": asset1["id"], "quantity": 2,
            "receiver_name": "赵强", "receiver_emp_no": "30208", "receiver_phone": "13800000004",
        })
        check("再认领 2 套后剩余归零", st == 200 and res["asset"]["remaining_count"] == 0, res)
        check("剩余归零自动下架", res["asset"]["status"] == "off", res)

        st, detail = req("GET", f"/api/assets/{asset1['id']}", t2)
        check("生成 2 条流转记录", len(detail["transfers"]) == 2, detail.get("transfers"))
        check("流转记录含转出/转入部门与接收人工号",
              all(t["from_dept_name"] and t["to_dept_name"] and t["receiver_emp_no"] for t in detail["transfers"]))

        # 已下架物资不可认领
        st, res = req("POST", "/api/claims", t1, body={
            "asset_id": asset1["id"], "quantity": 1,
            "receiver_name": "孙悦", "receiver_emp_no": "20156",
        })
        check("已下架物资不可认领", st in (400, 403), res)

        print("\n[7] 交接单")
        st, h = req("POST", "/api/handovers", t1, body={"claim_id": detail["transfers"][0]["id"]})
        check("生成交接单成功", st == 200 and bool(h.get("handover_no")), h)
        check("交接单含转出/转入部门与资产信息",
              all(k in h for k in ["from_dept_name", "to_dept_name", "asset_no", "asset_name", "quantity"]), h)
        st, h2 = req("GET", f"/api/handovers/{h['handover_no']}", t1)
        check("按单号查询交接单", st == 200 and h2["handover_no"] == h["handover_no"])
        st, res = req("GET", "/api/claims?asset_no=ZC-2026-101", ta)
        check("交接单号回填到流转记录",
              any(c["handover_no"] == h["handover_no"] for c in res), res)
        st, res = req("POST", f"/api/handovers/{h['handover_no']}/print", t1)
        check("打印日志记录成功", st == 200 and res["print_count"] == 1, res)

        print("\n[8] 我的记录")
        st, out = req("GET", "/api/claims/mine?direction=out", t1)
        check("转出历史可查", st == 200 and any(c["asset_no"] == "ZC-2026-101" for c in out), out)
        st, inn = req("GET", "/api/claims/mine?direction=in", t2)
        check("转入历史可查", st == 200 and any(c["asset_no"] == "ZC-2026-101" for c in inn), inn)
        st, hs = req("GET", "/api/handovers", t1)
        check("交接单列表可查", st == 200 and len(hs) >= 2, hs)

        print("\n[9] 管理员模块")
        st, res = req("POST", "/api/admin/colleges", ta, body={"name": "外国语学院", "code": "WGY"})
        check("组织机构：新增学院", st == 200, res)
        cid = res["id"]
        st, res = req("PUT", f"/api/admin/colleges/{cid}", ta, body={"name": "国际教育学院"})
        check("组织机构：学院改名", st == 200 and res["name"] == "国际教育学院", res)
        st, res = req("POST", "/api/admin/departments", ta,
                      body={"college_id": cid, "name": "语言实验中心"})
        check("组织机构：新增部门", st == 200, res)
        did = res["id"]
        st, res = req("PUT", f"/api/admin/departments/{did}", ta, body={"status": "disabled"})
        check("组织机构：部门停用", st == 200 and res["status"] == "disabled", res)

        st, res = req("POST", "/api/admin/users", ta, body={
            "username": "user3", "password": "123456", "name": "周敏",
            "employee_no": "40101", "phone": "13800000011",
            "college_id": colleges[0]["id"], "department_id": colleges[0]["departments"][0]["id"],
        })
        check("用户管理：新增用户", st == 200, res)
        uid = res["id"]
        st, res = req("POST", f"/api/admin/users/{uid}/status", ta, body={"status": "disabled"})
        check("用户管理：停用用户", st == 200 and res["status"] == "disabled", res)

        st, admin_assets = req("GET", "/api/admin/assets", ta)
        check("物资管理：全量查看", st == 200 and len(admin_assets) >= 5, len(admin_assets))
        target = [a for a in admin_assets if a["asset_no"] == "ZC-2026-003"][0]
        st, res = req("POST", f"/api/admin/assets/{target['id']}/force-off?reason=test", ta)
        check("物资管理：强制下架", st == 200 and res["status"] == "off", res)
        st, res = req("POST", f"/api/admin/assets/{target['id']}/relist", ta)
        check("物资管理：重新挂牌", st == 200 and res["status"] == "on", res)
        img = target["images"][0]
        st, res = req("POST", f"/api/admin/assets/{target['id']}/images/{img['id']}/reject", ta,
                      body={"reason": "疑似AI生成图"})
        check("物资管理：图片驳回", st == 200 and res["images"][0]["audit_status"] == "rejected", res)
        st, res = req("POST", f"/api/admin/assets/{target['id']}/images/{img['id']}/restore", ta)
        check("物资管理：撤销驳回", st == 200 and res["images"][0]["audit_status"] == "normal", res)

        st, logs = req("GET", "/api/admin/logs?type=claim", ta)
        check("日志中心：按类型筛选", st == 200 and len(logs) >= 2, logs)
        st, types = req("GET", "/api/admin/logs/types", ta)
        check("日志中心：类型字典", st == 200 and len(types) >= 10, types)
        # 日志不可删除：系统未提供任何 DELETE 接口
        st, res = req("DELETE", "/api/admin/logs/1", ta)
        check("日志中心：无删除接口（不可删除）", st in (404, 405), (st, res))
        st, res = req("POST", "/api/admin/logs/1/delete", ta)
        check("日志中心：无删除动作接口", st in (404, 405), (st, res))

        print("\n[9.1] 停用部门后物资可重新挂牌")
        st, before = req("GET", "/api/admin/assets", ta)
        stop_target = [a for a in before if a["asset_no"] == "ZC-2026-002"][0]
        stop_dept = [a for a in before if a["asset_no"] == "ZC-2026-002"][0]["department_id"]
        st, res = req("PUT", f"/api/admin/departments/{stop_dept}", ta, body={"status": "disabled"})
        check("停用部门成功", st == 200, res)
        st, after = req("GET", "/api/admin/assets", ta)
        off_asset = [a for a in after if a["id"] == stop_target["id"]][0]
        check("部门停用后其物资停止挂牌", off_asset["status"] == "disabled", off_asset)
        st, res = req("POST", f"/api/admin/assets/{stop_target['id']}/relist", ta)
        check("管理员可重新挂牌停用物资", st == 200 and res["status"] == "on", res)

        print("\n[10] 统计报表")
        st, ov = req("GET", "/api/admin/stats/overview", ta)
        check("统计总览", st == 200 and ov["asset_total"] >= 5, ov)
        st, sa = req("GET", "/api/admin/stats/assets", ta)
        check("按资产统计", st == 200 and len(sa) >= 5, len(sa))
        st, sd = req("GET", "/api/admin/stats/departments", ta)
        check("按部门统计", st == 200 and len(sd) >= 4, len(sd))

        print("\n[11] 权限边界")
        # 管理员不得发布/认领
        st, res = req("POST", "/api/claims", ta, body={
            "asset_id": asset1["id"], "quantity": 1,
            "receiver_name": "管理员", "receiver_emp_no": "90001",
        })
        check("管理员不可认领", st == 403, res)

        # 部门用户不得访问管理员接口
        st, res = req("GET", "/api/admin/users", t1)
        check("部门用户不可访问管理员接口", st == 403, res)

        print("\n[12] 导出接口鉴权（P0 回归：不带 token 必须 401）")
        export_paths = [
            "/api/admin/logs/export",
            "/api/admin/stats/export?type=assets",
            "/api/admin/stats/export?type=departments",
        ]
        for p in export_paths:
            st, _ = req_raw("GET", p)
            check(f"无 token 拒绝导出 {p}", st == 401, st)
            st, body = req_raw("GET", p, ta)
            check(f"管理员导出成功 {p}", st == 200 and len(body) > 0, (st, len(body)))

        print("\n[13] 交接单服务端导出 Word / PDF")
        st, hds = req("GET", "/api/handovers", ta)
        check("可查询交接单列表", st == 200 and len(hds) >= 1, hds)
        hno = hds[0]["handover_no"]
        st, docx = req_raw("GET", f"/api/handovers/{hno}/export?format=docx", t1)
        check("导出 Word 成功（docx 文件头 PK）", st == 200 and docx[:2] == b"PK", (st, docx[:4]))
        st, pdf = req_raw("GET", f"/api/handovers/{hno}/export?format=pdf", t1)
        check("导出 PDF 成功（%PDF 文件头）", st == 200 and pdf[:4] == b"%PDF", (st, pdf[:4]))
        st, res = req_raw("GET", f"/api/handovers/{hno}/export?format=xlsx", t1)
        check("非法导出格式被拒绝", st == 400, st)
        st, _ = req_raw("GET", f"/api/handovers/{hno}/export?format=docx")
        check("无 token 拒绝导出交接单", st == 401, st)

        print("\n[14] 管理员修正异常物资")
        st, before = req("GET", "/api/admin/assets", ta)
        fix_target = [a for a in before if a["status"] == "on"][0]
        st, fixed = req("PUT", f"/api/admin/assets/{fix_target['id']}", ta, body={
            "location": "修正后存放地点", "contact_phone": "13900000001",
            "reason": "冒烟测试：存放地点录入错误",
        })
        check("管理员可修正物资字段", st == 200 and fixed["location"] == "修正后存放地点", fixed)
        st, res = req("PUT", f"/api/admin/assets/{fix_target['id']}", ta, body={"total_count": 0})
        check("修正总数≤0 被拒绝", st == 400, res)
        st, res = req("PUT", f"/api/admin/assets/{fix_target['id']}", ta, body={
            "asset_no": "ZC-2026-004"  # 已被占用的编号
        })
        check("修正为重复资产编号被拒绝", st == 400, res)
        st, res = req("PUT", f"/api/admin/assets/{fix_target['id']}", ta, body={
            "contact_phone": "不是电话号码"
        })
        check("修正电话格式非法被拒绝", st == 400, res)
        st, logs = req("GET", "/api/admin/logs?asset_no=" + fix_target["asset_no"], ta)
        check("修正动作写入日志", any("管理员修正物资" in (l["detail"] or "") for l in logs), logs[:1])
        st, res = req("PUT", f"/api/admin/assets/{fix_target['id']}", t1, body={"location": "越权"})
        check("部门用户不可调用管理员修正接口", st == 403, res)

        print("\n[15] 管理员撤销认领（数量恢复）")
        # 用 user2 认领一条 user1 发布的物资，再由管理员撤销
        st, my_assets = req("GET", "/api/assets/mine", t1)
        target = [a for a in my_assets if a["status"] == "on"][0]
        qty_before = target["remaining_count"]
        st, res = req("POST", "/api/claims", t2, body={
            "asset_id": target["id"], "quantity": 1,
            "receiver_name": "赵强", "receiver_emp_no": "30208",
        })
        check("user2 认领成功", st == 200, res)
        claim_id = res["claim"]["id"]
        st, after_claim = req("GET", f"/api/assets/{target['id']}", t1)
        check("认领后剩余数量扣减 1",
              after_claim["remaining_count"] == qty_before - 1, after_claim["remaining_count"])
        st, rv = req(
            "POST",
            f"/api/claims/{claim_id}/revoke?reason=" + urllib.parse.quote("冒烟测试撤销"),
            ta,
        )
        check("管理员撤销认领成功", st == 200 and rv["status"] == "revoked", rv)
        st, after_revoke = req("GET", f"/api/assets/{target['id']}", t1)
        check("撤销后数量恢复", after_revoke["remaining_count"] == qty_before, after_revoke["remaining_count"])
        st, res = req("POST", f"/api/claims/{claim_id}/revoke", t1)
        check("部门用户不可撤销认领", st == 403, res)

        print("\n[16] 跨部门发布（发布人所属部门 → 实际发布部门，留痕）")
        # 从学院树里取一个"非本部门"的部门作为代发布目标
        # 注意：前面 [9] 做过停用测试，必须重新拉取最新的组织树
        st, colleges_now = req("GET", "/api/colleges", t1)
        other_dept = None
        for c in colleges_now:
            for d in c["departments"]:
                if d["id"] != u1["department_id"] and d["status"] == "active" and c["status"] == "active":
                    other_dept = {"college_id": c["id"], "id": d["id"], "name": d["name"]}
                    break
            if other_dept:
                break
        check("找到跨部门发布目标", other_dept is not None, colleges)
        st, cross = post_asset(t1, {
            "asset_no": "ZC-2026-777", "name": "跨部门代发布物资", "category": "测试",
            "unit": "台", "spec": "1×1", "total_count": 2, "condition_desc": "良好",
            "remark": "", "using_person": "代发布", "usage_direction": "测试",
            "manage_dept": "测试部", "location": "跨部门楼", "contact_person": "代发布",
            "contact_emp_no": "88888", "contact_phone": "13700000000",
            "college_id": other_dept["college_id"], "department_id": other_dept["id"],
            "cover_index": 0, "captions": '["正面照"]',
        }, [("files", "cross.png", make_unique_png())])
        check("跨部门发布被允许", st == 200, cross)
        if st == 200:
            st, detail = req("GET", f"/api/assets/{cross['id']}", t1)
            check("物资归属到所选发布部门",
                  detail["department_id"] == other_dept["id"], detail["department_id"])
            check("发布人仍记录为操作人本人",
                  detail["publisher_emp_no"] == u1["employee_no"], detail["publisher_emp_no"])
            st, logs = req("GET", "/api/admin/logs?asset_no=ZC-2026-777", ta)
            check("代发布关系写入日志",
                  any("代发布" in (l["detail"] or "") for l in logs), logs[:1])

        print("\n[17] 部门停用/启用：已领完的物资不得被错误上架")
        st, all_assets = req("GET", "/api/admin/assets", ta)
        done = [a for a in all_assets if a["status"] == "off" and a["remaining_count"] == 0]
        if done:
            d = done[0]
            st, depts = req("GET", f"/api/colleges/{d['college_id']}/departments", ta)
            dp = [x for x in depts if x["id"] == d["department_id"]][0]
            st, _ = req("PUT", f"/api/admin/departments/{dp['id']}", ta, body={"status": "disabled"})
            st, _ = req("PUT", f"/api/admin/departments/{dp['id']}", ta, body={"status": "active"})
            st, final = req("GET", "/api/admin/assets", ta)
            got = [a for a in final if a["id"] == d["id"]][0]
            check("部门重新启用后，剩余=0 的物资仍保持下架", got["status"] == "off", got)
        else:
            check("（跳过）无剩余=0 的已下架物资可验证", True)

        print(f"\n===== 结果：通过 {passed}，失败 {failed} =====")
        return 0 if failed == 0 else 1
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
