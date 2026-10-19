# -*- coding: utf-8 -*-
"""
路由：用户与工号管理（管理员）
------------------------------------------------------------------
负责接口：
  GET  /api/admin/users            用户列表（支持姓名/工号/账号/部门关键字查询）
  POST /api/admin/users            新增用户（工号唯一校验、部门有效性校验）
  PUT  /api/admin/users/{id}       修改用户（姓名/工号/电话/学院部门/角色/口令）
  POST /api/admin/users/{id}/status 启用 / 停用
依赖页面：frontend/admin/users.html
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..auth import hash_password
from ..database import get_db
from ..deps import full_dept_name, require_admin, write_log
from ..models import College, Department, User
from ..schemas import UserCreate, UserUpdate

router = APIRouter(prefix="/api/admin/users", tags=["用户与工号管理"])


class StatusIn(BaseModel):
    status: str  # active | disabled


def _user_out(db: Session, u: User) -> dict:
    college = db.query(College).filter(College.id == u.college_id).first()
    dept = db.query(Department).filter(Department.id == u.department_id).first()
    return {
        "id": u.id,
        "username": u.username,
        "name": u.name,
        "employee_no": u.employee_no,
        "phone": u.phone,
        "role": u.role,
        "college_id": u.college_id,
        "department_id": u.department_id,
        "college_name": college.name if college else "",
        "department_name": dept.name if dept else "",
        "dept_full_name": full_dept_name(db, u.college_id, u.department_id),
        "status": u.status,
        "created_at": u.created_at.strftime("%Y-%m-%d %H:%M:%S") if u.created_at else "",
    }


@router.get("")
def list_users(keyword: str = "", db: Session = Depends(get_db), admin=Depends(require_admin)):
    """用户列表，keyword 支持账号/姓名/工号/部门名模糊匹配"""
    q = db.query(User)
    if keyword.strip():
        kw = f"%{keyword.strip()}%"
        dept_ids = [d.id for d in db.query(Department).filter(Department.name.like(kw)).all()]
        college_ids = [c.id for c in db.query(College).filter(College.name.like(kw)).all()]
        from sqlalchemy import or_
        conds = [
            User.username.like(kw),
            User.name.like(kw),
            User.employee_no.like(kw),
        ]
        if dept_ids:
            conds.append(User.department_id.in_(dept_ids))
        if college_ids:
            conds.append(User.college_id.in_(college_ids))
        q = q.filter(or_(*conds))
    users = q.order_by(User.id).all()
    return [_user_out(db, u) for u in users]


@router.post("")
def create_user(
    payload: UserCreate,
    request: Request,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """新增用户：账号唯一、工号唯一、学院部门必须有效"""
    username = payload.username.strip()
    if not username:
        raise HTTPException(status_code=400, detail="登录账号不能为空")
    if db.query(User).filter(User.username == username).first():
        raise HTTPException(status_code=400, detail="该登录账号已存在")
    if payload.employee_no.strip() and db.query(User).filter(User.employee_no == payload.employee_no.strip()).first():
        raise HTTPException(status_code=400, detail="该工号已存在")

    college = db.query(College).filter(College.id == payload.college_id).first() if payload.college_id else None
    dept = db.query(Department).filter(Department.id == payload.department_id).first() if payload.department_id else None
    if payload.role == "user" and dept is None:
        raise HTTPException(status_code=400, detail="部门用户必须指定所属下设部门")
    if dept is not None and college is not None and dept.college_id != college.id:
        raise HTTPException(status_code=400, detail="所选部门不属于所选学院，请重新选择")

    pwd_hash, salt = hash_password(payload.password or "123456")
    u = User(
        username=username,
        password_hash=pwd_hash,
        salt=salt,
        name=payload.name.strip(),
        employee_no=payload.employee_no.strip(),
        phone=payload.phone.strip(),
        role=payload.role if payload.role in ("user", "admin") else "user",
        college_id=college.id if college else (dept.college_id if dept else None),
        department_id=payload.department_id,
    )
    db.add(u)
    write_log(db, "user_change", admin, f"新增用户：{u.name}（工号 {u.employee_no}）", request=request)
    db.commit()
    db.refresh(u)
    return _user_out(db, u)


@router.put("/{user_id}")
def update_user(
    user_id: int,
    payload: UserUpdate,
    request: Request,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """修改用户资料；口令留空表示不修改"""
    u = db.query(User).filter(User.id == user_id).first()
    if u is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    changes = []

    if payload.name is not None and payload.name.strip() and payload.name.strip() != u.name:
        changes.append(f"姓名 {u.name} -> {payload.name.strip()}")
        u.name = payload.name.strip()

    if payload.employee_no is not None:
        eno = payload.employee_no.strip()
        if eno and eno != u.employee_no:
            if db.query(User).filter(User.employee_no == eno, User.id != u.id).first():
                raise HTTPException(status_code=400, detail="该工号已存在")
            changes.append(f"工号 {u.employee_no} -> {eno}")
            u.employee_no = eno

    if payload.phone is not None and payload.phone != u.phone:
        changes.append(f"电话 {u.phone} -> {payload.phone}")
        u.phone = payload.phone

    if payload.role is not None and payload.role in ("user", "admin") and payload.role != u.role:
        changes.append(f"角色 {u.role} -> {payload.role}")
        u.role = payload.role

    if payload.college_id is not None and payload.college_id != u.college_id:
        college = db.query(College).filter(College.id == payload.college_id).first()
        if college is None:
            raise HTTPException(status_code=400, detail="所选学院不存在")
        changes.append(f"学院 -> {college.name}")
        u.college_id = college.id

    if payload.department_id is not None and payload.department_id != u.department_id:
        dept = db.query(Department).filter(Department.id == payload.department_id).first()
        if dept is None:
            raise HTTPException(status_code=400, detail="所选部门不存在")
        changes.append(f"部门 -> {dept.name}")
        u.department_id = dept.id
        u.college_id = dept.college_id

    if payload.status is not None and payload.status in ("active", "disabled") and payload.status != u.status:
        changes.append(f"状态 {u.status} -> {payload.status}")
        u.status = payload.status

    if payload.password:
        pwd_hash, salt = hash_password(payload.password)
        u.password_hash = pwd_hash
        u.salt = salt
        changes.append("重置口令")

    if not changes:
        return _user_out(db, u)
    write_log(db, "user_change", admin, f"修改用户[{u.name}]：" + "；".join(changes), request=request)
    db.commit()
    return _user_out(db, u)


@router.post("/{user_id}/status")
def set_status(
    user_id: int,
    payload: StatusIn,
    request: Request,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """启用 / 停用用户账号"""
    if payload.status not in ("active", "disabled"):
        raise HTTPException(status_code=400, detail="状态值非法")
    u = db.query(User).filter(User.id == user_id).first()
    if u is None:
        raise HTTPException(status_code=404, detail="用户不存在")
    if u.id == admin.id and payload.status == "disabled":
        raise HTTPException(status_code=400, detail="不能停用当前登录的管理员账号")
    u.status = payload.status
    write_log(
        db,
        "user_change",
        admin,
        f"{'停用' if payload.status == 'disabled' else '启用'}用户：{u.name}（工号 {u.employee_no}）",
        request=request,
    )
    db.commit()
    return _user_out(db, u)
