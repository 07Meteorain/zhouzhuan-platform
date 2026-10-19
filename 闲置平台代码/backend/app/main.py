# -*- coding: utf-8 -*-
"""
应用入口
------------------------------------------------------------------
- 启动时自动建表（Base.metadata.create_all）
- 若用户表为空，则执行 database/seed.py 注入种子数据（2 学院 4 部门 / 3 物资 / 1 认领 / 2 账号）
- 挂载 /uploads 为本地图片静态目录
- 注册全部路由分组
"""
import importlib.util
import os
import sys

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from .config import (
    CORS_ORIGINS,
    DATABASE_PATH,
    SEED_IMAGE_DIR,
    SEED_SCRIPT,
    UPLOAD_DIR,
    ensure_dirs,
)
from .database import Base, SessionLocal, engine
from .models import Asset, College, Department, Log, User  # noqa: F401  确保表被注册
from .routers import assets, auth, claims, handovers, logs, orgs, stats, users

ensure_dirs()


def _run_seed_if_needed() -> None:
    """首次启动（用户表为空）时执行种子脚本，注入可演示的真实结构数据"""
    db = SessionLocal()
    try:
        if db.query(User).count() > 0:
            return
        if not os.path.exists(SEED_SCRIPT):
            print(f"[seed] 未找到种子脚本 {SEED_SCRIPT}，跳过注入")
            return
        spec = importlib.util.spec_from_file_location("project_seed", SEED_SCRIPT)
        if spec is None or spec.loader is None:
            print("[seed] 种子脚本加载失败，跳过注入")
            return
        module = importlib.util.module_from_spec(spec)
        sys.modules["project_seed"] = module
        spec.loader.exec_module(module)
        if hasattr(module, "run_seed"):
            module.run_seed(db, image_dir=SEED_IMAGE_DIR, upload_dir=UPLOAD_DIR)
            print("[seed] 种子数据注入完成")
        else:
            print("[seed] 种子脚本缺少 run_seed 函数，跳过注入")
    except Exception as e:  # 种子失败不应阻断服务启动
        print(f"[seed] 注入失败：{e}")
    finally:
        db.close()


app = FastAPI(
    title="公共资产闲置平台 API",
    description="部门用户在公共资产闲置平台上发布与认领闲置资产，管理员负责组织架构、核验与留痕统计。",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# 本地图片存储：/uploads/xxx.jpg
app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")

# 路由注册（分组见各路由文件顶部注释）
app.include_router(auth.router)
app.include_router(orgs.router)
app.include_router(users.router)
app.include_router(assets.router)
app.include_router(claims.router)
app.include_router(handovers.router)
app.include_router(logs.router)
app.include_router(stats.router)


@app.on_event("startup")
def on_startup() -> None:
    """建表 + 注入种子数据"""
    Base.metadata.create_all(bind=engine)
    _run_seed_if_needed()


@app.get("/api/health")
def health():
    """健康检查：返回服务状态与关键配置（取自 config，反映实际生效值，便于排障）"""
    return {
        "status": "ok",
        "database": DATABASE_PATH,
        "upload_dir": UPLOAD_DIR,
        "seed_script": SEED_SCRIPT,
        "seed_image_dir": SEED_IMAGE_DIR,
    }


@app.exception_handler(Exception)
def unhandled_exception_handler(request, exc):  # pragma: no cover
    """兜底异常处理，保证前端总能拿到可读错误信息"""
    return JSONResponse(status_code=500, content={"detail": f"服务端异常：{exc}"})
