# -*- coding: utf-8 -*-
"""
路由：认证与当前用户
------------------------------------------------------------------
负责接口：
  POST /api/auth/login    登录，返回 JWT
  GET  /api/auth/me       获取当前登录用户（含“学院 + 下设部门”）
  POST /api/auth/logout   退出登录（服务端记录日志，前端清除 token）
依赖页面：frontend/index.html（登录页）、所有页面的鉴权守卫
"""
from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from ..auth import create_token, verify_password
from ..database import get_db
from ..deps import full_dept_name, get_current_user, write_log
from ..models import College, Department, User
from ..schemas import LoginIn

router = APIRouter(prefix="/api/auth", tags=["认证"])


@router.post("/login")
def login(payload: LoginIn, request: Request, db: Session = Depends(get_db)):
    """账号口令登录；校验失败返回 400，账号停用返回 403"""
    user = db.query(User).filter(User.username == payload.username.strip()).first()
    if user is None or not verify_password(payload.password, user.password_hash, user.salt):
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="账号或口令不正确")
    if user.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账号已停用，请联系管理员")

    token = create_token(user.id, user.username, user.role)
    write_log(db, "login", user, f"用户 {user.name} 登录系统", request=request)
    db.commit()

    college = db.query(College).filter(College.id == user.college_id).first()
    dept = db.query(Department).filter(Department.id == user.department_id).first()
    return {
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "name": user.name,
            "employee_no": user.employee_no,
            "phone": user.phone,
            "role": user.role,
            "college_id": user.college_id,
            "department_id": user.department_id,
            "college_name": college.name if college else "",
            "department_name": dept.name if dept else "",
            "dept_full_name": full_dept_name(db, user.college_id, user.department_id),
            "status": user.status,
        },
    }


@router.get("/me")
def me(current_user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    """返回当前登录用户；前端各页面启动时调用以渲染顶部信息"""
    college = db.query(College).filter(College.id == current_user.college_id).first()
    dept = db.query(Department).filter(Department.id == current_user.department_id).first()
    return {
        "id": current_user.id,
        "username": current_user.username,
        "name": current_user.name,
        "employee_no": current_user.employee_no,
        "phone": current_user.phone,
        "role": current_user.role,
        "college_id": current_user.college_id,
        "department_id": current_user.department_id,
        "college_name": college.name if college else "",
        "department_name": dept.name if dept else "",
        "dept_full_name": full_dept_name(db, current_user.college_id, current_user.department_id),
        "status": current_user.status,
    }


@router.post("/logout")
def logout(
    request: Request,
    current_user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """退出登录：记录日志，前端负责清除本地 token"""
    write_log(db, "login", current_user, f"用户 {current_user.name} 退出登录", request=request)
    db.commit()
    return {"message": "已退出登录"}
