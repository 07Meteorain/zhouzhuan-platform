# -*- coding: utf-8 -*-
"""
数据库连接模块
------------------------------------------------------------------
SQLite + SQLAlchemy。提供：
  - engine / SessionLocal / Base
  - get_db：FastAPI 依赖，每个请求一个会话，请求结束自动关闭
"""
from sqlalchemy import create_engine
from sqlalchemy.orm import declarative_base, sessionmaker

from .config import DATABASE_PATH, ensure_dirs

ensure_dirs()

# check_same_thread=False：SQLite 在多线程 Web 服务下的必要配置
engine = create_engine(
    f"sqlite:///{DATABASE_PATH}",
    connect_args={"check_same_thread": False},
    echo=False,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)

Base = declarative_base()


def get_db():
    """FastAPI 依赖项：-yield 一个数据库会话并在请求结束后关闭"""
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
