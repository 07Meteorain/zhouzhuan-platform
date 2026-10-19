# -*- coding: utf-8 -*-
"""
认证与安全模块
------------------------------------------------------------------
- 口令：PBKDF2-HMAC-SHA256 + 随机盐（Python 标准库实现，无第三方编译依赖）
- 令牌：JWT（PyJWT），登录后前端保存 token，请求头 Authorization: Bearer <token>
"""
import hashlib
import hmac
import os
import secrets
from datetime import datetime, timedelta

import jwt

from .config import JWT_ALGORITHM, JWT_EXPIRE_HOURS, SECRET_KEY


# --------------------------- 口令处理 ---------------------------

def hash_password(password: str, salt: str | None = None) -> tuple[str, str]:
    """生成口令哈希，返回 (hash_hex, salt_hex)"""
    if salt is None:
        salt = secrets.token_hex(16)
    pwd_hash = hashlib.pbkdf2_hmac(
        "sha256", password.encode("utf-8"), salt.encode("utf-8"), 120_000
    ).hex()
    return pwd_hash, salt


def verify_password(password: str, pwd_hash: str, salt: str) -> bool:
    """校验口令，使用 hmac.compare_digest 防止时序攻击"""
    calc, _ = hash_password(password, salt)
    return hmac.compare_digest(calc, pwd_hash)


# --------------------------- JWT 处理 ---------------------------

def create_token(user_id: int, username: str, role: str) -> str:
    """签发 JWT，有效期见 JWT_EXPIRE_HOURS"""
    expire = datetime.utcnow() + timedelta(hours=JWT_EXPIRE_HOURS)
    payload = {
        "sub": str(user_id),
        "username": username,
        "role": role,
        "exp": expire,
    }
    return jwt.encode(payload, SECRET_KEY, algorithm=JWT_ALGORITHM)


def decode_token(token: str) -> dict | None:
    """解析 JWT，失败返回 None"""
    try:
        return jwt.decode(token, SECRET_KEY, algorithms=[JWT_ALGORITHM])
    except Exception:
        return None
