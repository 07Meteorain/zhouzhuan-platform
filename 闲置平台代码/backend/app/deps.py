# -*- coding: utf-8 -*-
"""
公共依赖与工具
------------------------------------------------------------------
- get_current_user：解析 Authorization 头中的 JWT，得到当前登录用户
- require_admin：管理员角色校验
- write_log：统一写操作日志（覆盖发布/修改/下架/认领/图片/组织/用户/交接单）
- full_dept_name / asset_to_dict：通用序列化辅助
"""
from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from .auth import decode_token
from .config import UPLOAD_DIR
from .database import get_db
from .models import Asset, AssetImage, College, Department, Log, User

# auto_error=False：由我们自己返回统一格式的错误，避免 422 干扰前端
bearer_scheme = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(bearer_scheme),
    db: Session = Depends(get_db),
) -> User:
    """从请求头解析 JWT 并返回用户对象；未登录或已停用则 401"""
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录或登录已失效")
    payload = decode_token(credentials.credentials)
    if not payload:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="未登录或登录已失效")
    user = db.query(User).filter(User.id == int(payload.get("sub"))).first()
    if user is None:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="用户不存在")
    if user.status != "active":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="账号已停用，请联系管理员")
    return user


def require_admin(current_user: User = Depends(get_current_user)) -> User:
    """要求管理员角色"""
    if current_user.role != "admin":
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="仅平台管理员可执行该操作")
    return current_user


def write_log(
    db: Session,
    type: str,
    operator: User | None,
    detail: str,
    asset_no: str = "",
    quantity: int | None = None,
    request: Request | None = None,
) -> None:
    """写入一条操作日志（追加，任何接口都不提供删除能力）"""
    dept_name = full_dept_name(db, operator.college_id, operator.department_id) if operator else ""
    ip = ""
    if request is not None:
        ip = request.headers.get("x-forwarded-for", "") or (
            request.client.host if request.client else ""
        )
    log = Log(
        type=type,
        operator_id=operator.id if operator else None,
        operator_name=operator.name if operator else "系统",
        emp_no=operator.employee_no if operator else "",
        dept_name=dept_name,
        asset_no=asset_no,
        quantity=quantity,
        detail=detail,
        ip=ip,
    )
    db.add(log)
    # 注意：由调用方统一 commit，保证业务数据与日志同事务


def full_dept_name(db: Session, college_id: int | None, dept_id: int | None) -> str:
    """拼接“专业学院 + 下设部门”"""
    parts = []
    if college_id:
        c = db.query(College).filter(College.id == college_id).first()
        if c:
            parts.append(c.name)
    if dept_id:
        d = db.query(Department).filter(Department.id == dept_id).first()
        if d:
            parts.append(d.name)
    return " / ".join(parts) if parts else "-"


def dept_label(db: Session, asset: Asset) -> str:
    return full_dept_name(db, asset.college_id, asset.department_id)


# ---------------------- 物资序列化（统一输出结构） ----------------------

def image_dict(img: AssetImage) -> dict:
    return {
        "id": img.id,
        "url": img.url,
        "filename": img.filename,
        "origin_filename": img.origin_filename,
        "is_cover": bool(img.is_cover),
        "caption": img.caption,
        "uploader_name": img.uploader_name,
        "uploader_emp_no": img.uploader_emp_no,
        "uploader_dept": img.uploader_dept,
        "upload_time": img.upload_time.strftime("%Y-%m-%d %H:%M:%S") if img.upload_time else "",
        "file_size": img.file_size,
        "width": img.width,
        "height": img.height,
        "watermark": img.watermark,
        "audit_status": img.audit_status,
        "reject_reason": img.reject_reason,
    }


def asset_dict(
    db: Session, asset: Asset, with_images: bool = True, include_rejected: bool = False
) -> dict:
    """
    物资统一输出；列表与详情共用，避免字段不一致。
    include_recepted=False（默认）时过滤掉管理员驳回的图片，
    保证公共平台"仅展示通过真实性规则上传的图片"。
    """
    images = []
    if with_images:
        imgs = [
            i
            for i in asset.images
            if include_rejected or (i.audit_status or "normal") != "rejected"
        ]
        imgs = sorted(imgs, key=lambda x: (not x.is_cover, x.id))
        images = [image_dict(i) for i in imgs]
    return {
        "id": asset.id,
        "asset_no": asset.asset_no,
        "name": asset.name,
        "category": asset.category,
        "unit": asset.unit,
        "spec": asset.spec,
        "total_count": asset.total_count,
        "claimed_count": asset.claimed_count,
        "remaining_count": asset.remaining_count,
        "condition_desc": asset.condition_desc,
        "remark": asset.remark,
        "using_person": asset.using_person,
        "usage_direction": asset.usage_direction,
        "manage_dept": asset.manage_dept,
        "location": asset.location,
        "contact_person": asset.contact_person,
        "contact_emp_no": asset.contact_emp_no,
        "contact_phone": asset.contact_phone,
        "college_id": asset.college_id,
        "department_id": asset.department_id,
        "college_name": (db.query(College).filter(College.id == asset.college_id).first() or College(name="")).name,
        "department_name": (db.query(Department).filter(Department.id == asset.department_id).first() or Department(name="")).name,
        "dept_full_name": dept_label(db, asset),
        "publisher_name": asset.publisher_name,
        "publisher_emp_no": asset.publisher_emp_no,
        "publish_time": asset.publish_time.strftime("%Y-%m-%d %H:%M:%S") if asset.publish_time else "",
        "updated_at": asset.updated_at.strftime("%Y-%m-%d %H:%M:%S") if asset.updated_at else "",
        "status": asset.status,
        "images": images,
        "cover": images[0]["url"] if images else "",
    }


def claim_dict(db: Session, c) -> dict:
    return {
        "id": c.id,
        "asset_id": c.asset_id,
        "asset_no": c.asset_no,
        "asset_name": c.asset_name,
        "unit": c.unit,
        "quantity": c.quantity,
        "from_dept_id": c.from_dept_id,
        "to_dept_id": c.to_dept_id,
        "from_dept_name": c.from_dept_name,
        "to_dept_name": c.to_dept_name,
        "asset_id": c.asset_id,
        "receiver_name": c.receiver_name,
        "receiver_emp_no": c.receiver_emp_no,
        "receiver_phone": c.receiver_phone,
        "claim_time": c.claim_time.strftime("%Y-%m-%d %H:%M:%S") if c.claim_time else "",
        "handover_no": c.handover_no,
        "remark": c.remark,
        "status": c.status,
    }
