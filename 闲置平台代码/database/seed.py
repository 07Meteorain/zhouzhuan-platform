# -*- coding: utf-8 -*-
"""
种子数据脚本
------------------------------------------------------------------
用途：首次启动自动注入（后端 main.py 在用户表为空时调用 run_seed），
      也可独立执行：  python database/seed.py

注入内容：
  - 2 个专业学院（各 2 个下设部门，共 4 个部门）
  - 3 条已上架闲置物资 + 1 条已被领走（剩余 0 自动下架）的物资
  - 1 条已完成认领流转记录（含交接单号）
  - 3 个账号：user1/123456（智能制造学院/实训中心）、
              user2/123456（信息技术学院/网络运维部）、
              admin1/123456（平台管理员）

维护提示：本脚本内建表 SQL 必须与 backend/app/models.py 保持一致；
          扩展表字段时请同时修改这两处（见 README 二次开发指南）。
"""
import hashlib
import os
import secrets
import shutil
import sqlite3
import sys
from datetime import datetime

# 图片真实性水印所需的 Pillow；缺失时退化为直接复制原图
try:
    from PIL import Image, ImageDraw, ImageFont
    HAS_PIL = True
except Exception:  # pragma: no cover
    HAS_PIL = False


# ---------------------------------------------------------------- 口令

def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    """与 backend/app/auth.py 保持一致的 PBKDF2-SHA256 实现"""
    if salt is None:
        salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000
    ).hex()
    return pwd_hash, salt


# ---------------------------------------------------------------- 建表

SCHEMA_SQL = [
    # 专业学院
    """
    CREATE TABLE IF NOT EXISTS colleges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name VARCHAR(100) NOT NULL UNIQUE,
        code VARCHAR(50) DEFAULT '',
        status VARCHAR(20) DEFAULT 'active',
        created_at DATETIME
    )
    """,
    # 学院下设部门
    """
    CREATE TABLE IF NOT EXISTS departments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        college_id INTEGER NOT NULL,
        name VARCHAR(100) NOT NULL,
        code VARCHAR(50) DEFAULT '',
        status VARCHAR(20) DEFAULT 'active',
        created_at DATETIME,
        FOREIGN KEY(college_id) REFERENCES colleges(id)
    )
    """,
    # 用户与工号
    """
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username VARCHAR(50) NOT NULL UNIQUE,
        password_hash VARCHAR(128) NOT NULL,
        salt VARCHAR(32) NOT NULL,
        name VARCHAR(50) DEFAULT '',
        employee_no VARCHAR(50) DEFAULT '',
        phone VARCHAR(30) DEFAULT '',
        role VARCHAR(20) DEFAULT 'user',
        college_id INTEGER,
        department_id INTEGER,
        status VARCHAR(20) DEFAULT 'active',
        created_at DATETIME
    )
    """,
    # 物资主数据
    """
    CREATE TABLE IF NOT EXISTS assets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_no VARCHAR(64) NOT NULL UNIQUE,
        name VARCHAR(120) NOT NULL,
        category VARCHAR(60) DEFAULT '',
        unit VARCHAR(30) DEFAULT '件',
        spec VARCHAR(120) DEFAULT '',
        total_count INTEGER DEFAULT 0,
        claimed_count INTEGER DEFAULT 0,
        remaining_count INTEGER DEFAULT 0,
        condition_desc VARCHAR(200) DEFAULT '',
        remark TEXT DEFAULT '',
        using_person VARCHAR(60) DEFAULT '',
        usage_direction VARCHAR(120) DEFAULT '',
        manage_dept VARCHAR(120) DEFAULT '',
        location VARCHAR(120) DEFAULT '',
        contact_person VARCHAR(60) DEFAULT '',
        contact_emp_no VARCHAR(50) DEFAULT '',
        contact_phone VARCHAR(30) DEFAULT '',
        college_id INTEGER,
        department_id INTEGER,
        publisher_id INTEGER,
        publisher_name VARCHAR(60) DEFAULT '',
        publisher_emp_no VARCHAR(50) DEFAULT '',
        publish_time DATETIME,
        status VARCHAR(20) DEFAULT 'on',
        updated_at DATETIME
    )
    """,
    # 物资图片
    """
    CREATE TABLE IF NOT EXISTS asset_images (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        filename VARCHAR(200) NOT NULL,
        origin_filename VARCHAR(200) DEFAULT '',
        url VARCHAR(300) DEFAULT '',
        is_cover BOOLEAN DEFAULT 0,
        caption VARCHAR(200) DEFAULT '',
        uploader_id INTEGER,
        uploader_name VARCHAR(60) DEFAULT '',
        uploader_emp_no VARCHAR(50) DEFAULT '',
        uploader_dept VARCHAR(120) DEFAULT '',
        upload_time DATETIME,
        file_size INTEGER DEFAULT 0,
        width INTEGER DEFAULT 0,
        height INTEGER DEFAULT 0,
        sha256 VARCHAR(64) DEFAULT '',
        watermark VARCHAR(200) DEFAULT '',
        audit_status VARCHAR(20) DEFAULT 'normal',
        reject_reason VARCHAR(300) DEFAULT '',
        FOREIGN KEY(asset_id) REFERENCES assets(id)
    )
    """,
    # 认领记录（= 流转记录）
    """
    CREATE TABLE IF NOT EXISTS claims (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset_id INTEGER NOT NULL,
        asset_no VARCHAR(64) DEFAULT '',
        asset_name VARCHAR(120) DEFAULT '',
        unit VARCHAR(30) DEFAULT '',
        quantity INTEGER DEFAULT 0,
        from_college_id INTEGER,
        from_dept_id INTEGER,
        from_dept_name VARCHAR(160) DEFAULT '',
        to_college_id INTEGER,
        to_dept_id INTEGER,
        to_dept_name VARCHAR(160) DEFAULT '',
        receiver_name VARCHAR(60) DEFAULT '',
        receiver_emp_no VARCHAR(50) DEFAULT '',
        receiver_phone VARCHAR(30) DEFAULT '',
        claim_time DATETIME,
        handover_no VARCHAR(64) DEFAULT '',
        remark TEXT DEFAULT '',
        claimer_id INTEGER,
        status VARCHAR(20) DEFAULT 'normal',
        FOREIGN KEY(asset_id) REFERENCES assets(id)
    )
    """,
    # 交接单
    """
    CREATE TABLE IF NOT EXISTS handovers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        handover_no VARCHAR(64) NOT NULL UNIQUE,
        claim_id INTEGER NOT NULL,
        asset_id INTEGER,
        generated_by INTEGER,
        generated_by_name VARCHAR(60) DEFAULT '',
        generated_time DATETIME,
        print_count INTEGER DEFAULT 0,
        FOREIGN KEY(claim_id) REFERENCES claims(id)
    )
    """,
    # 操作日志（不可删除）
    """
    CREATE TABLE IF NOT EXISTS logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type VARCHAR(40) DEFAULT '',
        operator_id INTEGER,
        operator_name VARCHAR(60) DEFAULT '',
        emp_no VARCHAR(50) DEFAULT '',
        dept_name VARCHAR(160) DEFAULT '',
        asset_no VARCHAR(64) DEFAULT '',
        quantity INTEGER,
        time DATETIME,
        detail TEXT DEFAULT '',
        ip VARCHAR(64) DEFAULT ''
    )
    """,
]


# ---------------------------------------------------------------- 水印

def _watermark(src_path: str, dst_path: str, text: str) -> None:
    """给种子图片叠加水印（与线上上传路径一致），失败则退化为复制"""
    if not HAS_PIL:
        shutil.copy(src_path, dst_path)
        return
    try:
        img = Image.open(src_path).convert("RGB")
        draw = ImageDraw.Draw(img)
        font = None
        for path in [
            "C:/Windows/Fonts/msyh.ttc",
            "C:/Windows/Fonts/simhei.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetye/wqy/wqy-zenhei.ttc",
            "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
        ]:
            if os.path.exists(path):
                try:
                    font = ImageFont.truetype(path, max(16, img.width // 30))
                    break
                except Exception:
                    continue
        if font is None:
            font = ImageFont.load_default()
        try:
            bbox = draw.textbbox((0, 0), text, font=font)
            tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
        except AttributeError:
            tw, th = draw.textsize(text, font=font)
        x = max(10, img.width - tw - 10)
        y = max(10, img.height - th - 10)
        for dx, dy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
            draw.text((x + dx, y + dy), text, font=font, fill=(0, 0, 0))
        draw.text((x, y), text, font=font, fill=(255, 255, 255))
        img.save(dst_path, quality=90)
    except Exception:
        shutil.copy(src_path, dst_path)


# ---------------------------------------------------------------- 主流程

def run_seed(db, image_dir: str = "", upload_dir: str = "") -> None:
    """
    注入种子数据。
    db: SQLAlchemy Session（由后端传入）或 None（独立运行时自建 sqlite3 连接）
    """
    database_path = os.getenv(
        "DATABASE_PATH",
        os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "app.db"),
    )
    upload_dir = upload_dir or os.getenv(
        "UPLOAD_DIR", os.path.join(os.path.dirname(os.path.abspath(__file__)), "data", "uploads")
    )
    image_dir = image_dir or os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed_images")

    os.makedirs(upload_dir, exist_ok=True)
    os.makedirs(os.path.dirname(database_path), exist_ok=True)

    own_conn = None
    if db is None:
        # 独立执行：直连 sqlite3
        own_conn = sqlite3.connect(database_path)
        conn = own_conn

        def exec_sql(sql, params=None):
            return conn.execute(sql, params or {})
    else:
        # 由后端调用：借用传入的 SQLAlchemy Session
        def exec_sql(sql, params=None):
            from sqlalchemy import text

            return db.execute(text(sql), params or {})

    try:
        # 1) 建表
        for stmt in SCHEMA_SQL:
            exec_sql(stmt)

        # 2) 已有数据则不重复注入
        cur = exec_sql("SELECT COUNT(1) AS c FROM users")
        row = cur.fetchone()
        if row and int(row[0]) > 0:
            return

        now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

        # 3) 学院与部门
        colleges = [("智能制造学院", "ZNZZ"), ("信息技术学院", "XXJS")]
        college_ids = {}
        for name, code in colleges:
            cur = exec_sql(
                "INSERT INTO colleges (name, code, status, created_at) VALUES (:name, :code, 'active', :t)",
                {"name": name, "code": code, "t": now_str},
            )
            cid = cur.lastrowid if hasattr(cur, "lastrowid") else None
            if cid is None:
                cid = exec_sql("SELECT id FROM colleges WHERE name = :n", {"n": name}).fetchone()[0]
            college_ids[name] = cid

        dept_map = {
            "智能制造学院": ["实训中心", "设备管理办公室"],
            "信息技术学院": ["网络运维部", "实验室管理部"],
        }
        dept_ids = {}
        for cname, depts in dept_map.items():
            for dname in depts:
                cur = exec_sql(
                    "INSERT INTO departments (college_id, name, code, status, created_at) "
                    "VALUES (:cid, :name, :code, 'active', :t)",
                    {"cid": college_ids[cname], "name": dname, "code": "", "t": now_str},
                )
                did = cur.lastrowid if hasattr(cur, "lastrowid") else None
                if did is None:
                    did = exec_sql(
                        "SELECT id FROM departments WHERE college_id = :c AND name = :n",
                        {"c": college_ids[cname], "n": dname},
                    ).fetchone()[0]
                dept_ids[(cname, dname)] = did

        # 4) 用户
        def add_user(username, password, name, emp_no, phone, role, cname, dname):
            pwd_hash, salt = hash_password(password)
            cur = exec_sql(
                "INSERT INTO users (username, password_hash, salt, name, employee_no, phone, role, "
                "college_id, department_id, status, created_at) "
                "VALUES (:u, :p, :s, :n, :e, :ph, :r, :c, :d, 'active', :t)",
                {
                    "u": username,
                    "p": pwd_hash,
                    "s": salt,
                    "n": name,
                    "e": emp_no,
                    "ph": phone,
                    "r": role,
                    "c": college_ids.get(cname),
                    "d": dept_ids.get((cname, dname)) if dname else None,
                    "t": now_str,
                },
            )
            uid = cur.lastrowid if hasattr(cur, "lastrowid") else None
            if uid is None:
                uid = exec_sql("SELECT id FROM users WHERE username = :u", {"u": username}).fetchone()[0]
            return uid

        user1_id = add_user("user1", "123456", "孙悦", "20156", "13800000005", "user", "智能制造学院", "实训中心")
        user2_id = add_user("user2", "123456", "赵强", "30208", "13800000004", "user", "信息技术学院", "网络运维部")
        admin1_id = add_user("admin1", "123456", "平台管理员", "90001", "13800000900", "admin", "智能制造学院", "实训中心")

        # 5) 物资（3 条上架 + 1 条已被领走自动下架）
        #    图片来自 database/seed_images 下的真实照片，复制并加水印到上传目录
        assets_seed = [
            {
                "asset_no": "ZC-2026-001",
                "name": "多抽屉工具柜",
                "category": "柜类/存储设备",
                "unit": "台",
                "spec": "1800×900×400mm",
                "total_count": 6,
                "claimed_count": 0,
                "condition_desc": "八成新，柜体完好，抽屉滑轨顺滑，部分抽屉贴有旧标签",
                "remark": "实训室改造后闲置，可整批或分批调配",
                "using_person": "王建国",
                "usage_direction": "实训耗材存放",
                "manage_dept": "智能制造学院实训中心",
                "location": "工程训练中心 B203",
                "contact_person": "王建国",
                "contact_emp_no": "20117",
                "contact_phone": "13800000001",
                "college": "智能制造学院",
                "dept": "实训中心",
                "publisher_id": user1_id,
                "publisher_name": "孙悦",
                "publisher_emp_no": "20156",
                "status": "on",
                "images": [
                    ("多抽屉工具柜.png", "整柜正面实拍，柜体无变形"),
                ],
            },
            {
                "asset_no": "ZC-2026-002",
                "name": "手动液压堆高车",
                "category": "搬运设备",
                "unit": "台",
                "spec": "额定载荷 1000kg，最大起升高度 1600mm",
                "total_count": 2,
                "claimed_count": 0,
                "condition_desc": "九成新，液压系统正常，无渗漏",
                "remark": "需自提，可现场试机",
                "using_person": "李师傅",
                "usage_direction": "设备搬运与上架",
                "manage_dept": "智能制造学院设备管理办公室",
                "location": "工程训练中心 1 楼周转库",
                "contact_person": "李师傅",
                "contact_emp_no": "20134",
                "contact_phone": "13800000002",
                "college": "智能制造学院",
                "dept": "设备管理办公室",
                "publisher_id": user1_id,
                "publisher_name": "孙悦",
                "publisher_emp_no": "20156",
                "status": "on",
                "images": [
                    ("手动液压堆高车.png", "整车侧面实拍，货叉完好"),
                ],
            },
            {
                "asset_no": "ZC-2026-003",
                "name": "单层钢架床",
                "category": "生活家具",
                "unit": "张",
                "spec": "2000×900mm",
                "total_count": 20,
                "claimed_count": 0,
                "condition_desc": "七成新，床板完好，部分床架有掉漆",
                "remark": "值班宿舍调整后闲置，优先整批调配",
                "using_person": "张明",
                "usage_direction": "值班宿舍住宿",
                "manage_dept": "信息技术学院实验室管理部",
                "location": "信息楼 A1 宿舍备品间",
                "contact_person": "张明",
                "contact_emp_no": "30221",
                "contact_phone": "13800000003",
                "college": "信息技术学院",
                "dept": "实验室管理部",
                "publisher_id": user2_id,
                "publisher_name": "赵强",
                "publisher_emp_no": "30208",
                "status": "on",
                "images": [
                    ("床.png", "床架正面实拍，床板齐全"),
                ],
            },
            {
                "asset_no": "ZC-2026-004",
                "name": "手动液压托盘搬运车",
                "category": "搬运设备",
                "unit": "台",
                "spec": "额定载荷 2500kg，货叉长 1150mm",
                "total_count": 3,
                "claimed_count": 3,
                "condition_desc": "八成新，手柄回位正常，轮子磨损轻微",
                "remark": "已被其他部门认领完毕，系统自动下架",
                "using_person": "赵强",
                "usage_direction": "托盘物资短驳",
                "manage_dept": "信息技术学院网络运维部",
                "location": "信息楼 B2 耗材间",
                "contact_person": "赵强",
                "contact_emp_no": "30208",
                "contact_phone": "13800000004",
                "college": "信息技术学院",
                "dept": "网络运维部",
                "publisher_id": user2_id,
                "publisher_name": "赵强",
                "publisher_emp_no": "30208",
                "status": "off",
                "images": [
                    ("手动液压托盘搬运车.png", "搬运车正面实拍，手柄完好"),
                ],
            },
        ]

        asset_id_by_no = {}
        for item in assets_seed:
            remaining = item["total_count"] - item["claimed_count"]
            status = item["status"]
            if remaining == 0:
                status = "off"
            cur = exec_sql(
                "INSERT INTO assets (asset_no, name, category, unit, spec, total_count, claimed_count, "
                "remaining_count, condition_desc, remark, using_person, usage_direction, manage_dept, "
                "location, contact_person, contact_emp_no, contact_phone, college_id, department_id, "
                "publisher_id, publisher_name, publisher_emp_no, publish_time, status, updated_at) "
                "VALUES (:asset_no, :name, :category, :unit, :spec, :total_count, :claimed_count, "
                ":remaining_count, :condition_desc, :remark, :using_person, :usage_direction, :manage_dept, "
                ":location, :contact_person, :contact_emp_no, :contact_phone, :college_id, :department_id, "
                ":publisher_id, :publisher_name, :publisher_emp_no, :publish_time, :status, :updated_at)",
                {
                    "asset_no": item["asset_no"],
                    "name": item["name"],
                    "category": item["category"],
                    "unit": item["unit"],
                    "spec": item["spec"],
                    "total_count": item["total_count"],
                    "claimed_count": item["claimed_count"],
                    "remaining_count": remaining,
                    "condition_desc": item["condition_desc"],
                    "remark": item["remark"],
                    "using_person": item["using_person"],
                    "usage_direction": item["usage_direction"],
                    "manage_dept": item["manage_dept"],
                    "location": item["location"],
                    "contact_person": item["contact_person"],
                    "contact_emp_no": item["contact_emp_no"],
                    "contact_phone": item["contact_phone"],
                    "college_id": college_ids[item["college"]],
                    "department_id": dept_ids[(item["college"], item["dept"])],
                    "publisher_id": item["publisher_id"],
                    "publisher_name": item["publisher_name"],
                    "publisher_emp_no": item["publisher_emp_no"],
                    "publish_time": now_str,
                    "status": status,
                    "updated_at": now_str,
                },
            )
            aid = cur.lastrowid if hasattr(cur, "lastrowid") else None
            if aid is None:
                aid = exec_sql("SELECT id FROM assets WHERE asset_no = :n", {"n": item["asset_no"]}).fetchone()[0]
            asset_id_by_no[item["asset_no"]] = aid

            # 图片落盘 + 入库
            dept_full = f"{item['college']} / {item['dept']}"
            for idx, (img_file, caption) in enumerate(item["images"]):
                src = os.path.join(image_dir, img_file)
                if not os.path.exists(src):
                    continue
                ext = os.path.splitext(img_file)[1].lower() or ".png"
                new_name = f"seed_{item['asset_no'].replace('-', '')}_{idx}{ext}"
                dst = os.path.join(upload_dir, new_name)
                wm_text = f"{dept_full} · {item['asset_no']} · {now_str[:16]}"
                _watermark(src, dst, wm_text)

                with open(src, "rb") as f:
                    raw = f.read()
                sha = hashlib.sha256(raw).hexdigest()
                width = height = 0
                if HAS_PIL:
                    try:
                        with Image.open(dst) as im:
                            width, height = im.size
                    except Exception:
                        pass

                exec_sql(
                    "INSERT INTO asset_images (asset_id, filename, origin_filename, url, is_cover, caption, "
                    "uploader_id, uploader_name, uploader_emp_no, uploader_dept, upload_time, file_size, "
                    "width, height, sha256, watermark, audit_status, reject_reason) "
                    "VALUES (:asset_id, :filename, :origin, :url, :cover, :caption, :uid, :uname, :ueno, :udept, "
                    ":t, :size, :w, :h, :sha, :wm, 'normal', '')",
                    {
                        "asset_id": aid,
                        "filename": new_name,
                        "origin": img_file,
                        "url": f"/uploads/{new_name}",
                        "cover": 1 if idx == 0 else 0,
                        "caption": caption,
                        "uid": item["publisher_id"],
                        "uname": item["publisher_name"],
                        "ueno": item["publisher_emp_no"],
                        "udept": dept_full,
                        "t": now_str,
                        "size": os.path.getsize(dst),
                        "w": width,
                        "h": height,
                        "sha": sha,
                        "wm": wm_text,
                    }
                )

        # 6) 已完成认领流转记录（ZC-2026-004 已被领走，数量 3 -> 剩余 0 自动下架）
        handover_no = f"JJ{now_str[:10].replace('-', '')}0001"
        exec_sql(
            "INSERT INTO claims (asset_id, asset_no, asset_name, unit, quantity, from_college_id, from_dept_id, "
            "from_dept_name, to_college_id, to_dept_id, to_dept_name, receiver_name, receiver_emp_no, "
            "receiver_phone, claim_time, handover_no, remark, claimer_id, status) "
            "VALUES (:aid, :ano, :an, :u, :q, :fc, :fd, :fdn, :tc, :td, :tdn, :rn, :re, :rp, :t, :h, :rm, :cid, 'normal')",
            {
                "aid": asset_id_by_no["ZC-2026-004"],
                "ano": "ZC-2026-004",
                "an": "手动液压托盘搬运车",
                "u": "台",
                "q": 3,
                "fc": college_ids["信息技术学院"],
                "fd": dept_ids[("信息技术学院", "网络运维部")],
                "fdn": "信息技术学院 / 网络运维部",
                "tc": college_ids["智能制造学院"],
                "td": dept_ids[("智能制造学院", "实训中心")],
                "tdn": "智能制造学院 / 实训中心",
                "rn": "孙悦",
                "re": "20156",
                "rp": "13800000005",
                "t": now_str,
                "h": handover_no,
                "rm": "实训中心周转使用，已线下完成交接",
                "cid": user1_id,
            }
        )
        # SQLite AUTOINCREMENT / rowid：取刚插入的 claim id
        claim_row = exec_sql("SELECT id FROM claims WHERE handover_no = :h", {"h": handover_no}).fetchone()
        claim_id = claim_row[0] if claim_row else None
        if claim_id:
            exists = exec_sql(
                "SELECT id FROM handovers WHERE handover_no = :h", {"h": handover_no}
            ).fetchone()
            if not exists:
                exec_sql(
                    "INSERT INTO handovers (handover_no, claim_id, asset_id, generated_by, generated_by_name, "
                    "generated_time, print_count) VALUES (:h, :c, :a, :g, :gn, :t, 0)",
                    {
                        "h": handover_no,
                        "c": claim_id,
                        "a": asset_id_by_no["ZC-2026-004"],
                        "g": user1_id,
                        "gn": "孙悦",
                        "t": now_str,
                    },
                )

        # 7) 初始日志（发布/认领/交接单）
        def add_log(type, operator_id, operator_name, emp_no, dept_name, asset_no, quantity, detail, t):
            exec_sql(
                "INSERT INTO logs (type, operator_id, operator_name, emp_no, dept_name, asset_no, quantity, "
                "time, detail, ip) VALUES (:ty, :oid, :on, :e, :d, :a, :q, :t, :de, '')",
                {
                    "ty": type,
                    "oid": operator_id,
                    "on": operator_name,
                    "e": emp_no,
                    "d": dept_name,
                    "a": asset_no,
                    "q": quantity,
                    "t": t,
                    "de": detail,
                },
            )

        for item in assets_seed[:3]:
            add_log(
                "publish",
                item["publisher_id"],
                item["publisher_name"],
                item["publisher_emp_no"],
                f"{item['college']} / {item['dept']}",
                item["asset_no"],
                item["total_count"],
                f"发布物资：{item['name']}（编号 {item['asset_no']}，总数 {item['total_count']}{item['unit']}，图片 1 张）",
                now_str,
            )
        add_log(
            "claim",
            user1_id,
            "孙悦",
            "20156",
            "智能制造学院 / 实训中心",
            "ZC-2026-004",
            3,
            "认领物资：手动液压托盘搬运车（编号 ZC-2026-004）3台，"
            "信息技术学院 / 网络运维部 转出 -> 智能制造学院 / 实训中心 转入，接收人 孙悦（20156）",
            now_str,
        )
        add_log(
            "handover_gen",
            user1_id,
            "孙悦",
            "20156",
            "智能制造学院 / 实训中心",
            "ZC-2026-004",
            3,
            f"生成交接单 {handover_no}：手动液压托盘搬运车（ZC-2026-004）3台，"
            "信息技术学院 / 网络运维部 -> 智能制造学院 / 实训中心",
            now_str,
        )
        add_log(
            "image_upload",
            user1_id,
            "孙悦",
            "20156",
            "智能制造学院 / 实训中心",
            "ZC-2026-001",
            None,
            "为物资[ZC-2026-001]追加 1 张图片",
            now_str,
        )

        if own_conn is not None:
            own_conn.commit()
        else:
            db.commit()
    finally:
        if own_conn is not None:
            own_conn.close()


def main() -> None:
    """独立执行入口：python database/seed.py"""
    run_seed(None)
    print("种子数据注入完成")


if __name__ == "__main__":
    sys.exit(main())
