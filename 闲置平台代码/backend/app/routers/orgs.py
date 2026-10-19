# -*- coding: utf-8 -*-
"""
路由：组织机构（专业学院 + 下设部门）
------------------------------------------------------------------
负责接口：
  GET  /api/colleges                     学院列表（含下设部门，供两级联动使用）
  GET  /api/colleges/{id}/departments    某学院的下设部门
  POST /api/admin/colleges               新增学院（管理员）
  PUT  /api/admin/colleges/{id}          改名 / 启用停用（管理员）
  DELETE /api/admin/colleges/{id}        删除学院（无部门与用户关联时允许）
  POST /api/admin/departments            新增部门（管理员）
  PUT  /api/admin/departments/{id}       改名 / 启用停用（管理员）
  DELETE /api/admin/departments/{id}     删除部门（无用户与物资关联时允许）
依赖页面：frontend/user/publish.html（两级联动）、frontend/admin/orgs.html
"""
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import require_admin, write_log
from ..models import Asset, College, Department, User
from ..schemas import (
    CollegeIn,
    CollegeUpdate,
    DepartmentIn,
    DepartmentUpdate,
)

router = APIRouter(tags=["组织机构"])


# --------------------------- 公开查询部分 ---------------------------

@router.get("/api/colleges")
def list_colleges(db: Session = Depends(get_db)):
    """学院 + 部门树；发布页两级联动与搜索筛选共用"""
    colleges = db.query(College).order_by(College.id).all()
    result = []
    for c in colleges:
        depts = db.query(Department).filter(Department.college_id == c.id).order_by(Department.id).all()
        result.append(
            {
                "id": c.id,
                "name": c.name,
                "code": c.code,
                "status": c.status,
                "departments": [
                    {
                        "id": d.id,
                        "name": d.name,
                        "code": d.code,
                        "status": d.status,
                        "college_id": d.college_id,
                    }
                    for d in depts
                ],
            }
        )
    return result


@router.get("/api/colleges/{college_id}/departments")
def list_departments(college_id: int, db: Session = Depends(get_db)):
    """指定学院的下设部门列表，默认只返回启用部门"""
    depts = (
        db.query(Department)
        .filter(Department.college_id == college_id)
        .order_by(Department.id)
        .all()
    )
    return [
        {"id": d.id, "name": d.name, "code": d.code, "status": d.status, "college_id": d.college_id}
        for d in depts
    ]


# --------------------------- 管理员管理部分 ---------------------------

@router.post("/api/admin/colleges")
def create_college(
    payload: CollegeIn,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """新增专业学院；名称全局唯一"""
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="学院名称不能为空")
    if db.query(College).filter(College.name == name).first():
        raise HTTPException(status_code=400, detail="该学院名称已存在")
    c = College(name=name, code=payload.code.strip())
    db.add(c)
    write_log(db, "org_change", admin, f"新增专业学院：{name}", request=request)
    db.commit()
    db.refresh(c)
    return {"id": c.id, "name": c.name, "code": c.code, "status": c.status}


@router.put("/api/admin/colleges/{college_id}")
def update_college(
    college_id: int,
    payload: CollegeUpdate,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """学院改名 / 编码调整 / 启用停用；停用时同步停用其下部门与物资"""
    c = db.query(College).filter(College.id == college_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="学院不存在")

    changes = []
    if payload.name is not None and payload.name.strip() and payload.name.strip() != c.name:
        if db.query(College).filter(College.name == payload.name.strip(), College.id != c.id).first():
            raise HTTPException(status_code=400, detail="该学院名称已存在")
        changes.append(f"改名 {c.name} -> {payload.name.strip()}")
        c.name = payload.name.strip()
    if payload.code is not None and payload.code != c.code:
        changes.append(f"编码 {c.code} -> {payload.code}")
        c.code = payload.code
    if payload.status is not None and payload.status in ("active", "disabled"):
        if payload.status != c.status:
            changes.append(f"状态 {c.status} -> {payload.status}")
            c.status = payload.status
            for d in db.query(Department).filter(Department.college_id == c.id).all():
                d.status = payload.status
            # 停用：物资置为 disabled；启用：只恢复因停用而停用的物资，
            # 且遵守「剩余 = 0 自动下架」，已领完的物资不会因为学院启用被挂回平台
            for a in db.query(Asset).filter(Asset.college_id == c.id).all():
                if payload.status == "disabled":
                    a.status = "disabled"
                elif a.status == "disabled":
                    a.status = "on" if a.remaining_count > 0 else "off"

    if not changes:
        return {"id": c.id, "name": c.name, "code": c.code, "status": c.status, "message": "无变更"}

    write_log(db, "org_change", admin, f"修改学院[{c.name}]：" + "；".join(changes), request=request)
    db.commit()
    return {"id": c.id, "name": c.name, "code": c.code, "status": c.status}


@router.delete("/api/admin/colleges/{college_id}")
def delete_college(
    college_id: int,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """删除学院；存在下设部门或关联用户时拒绝，请先停用或迁移"""
    c = db.query(College).filter(College.id == college_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="学院不存在")
    if db.query(Department).filter(Department.college_id == c.id).count() > 0:
        raise HTTPException(status_code=400, detail="该学院下仍存在下设部门，无法删除（可先停用）")
    if db.query(User).filter(User.college_id == c.id).count() > 0:
        raise HTTPException(status_code=400, detail="该学院下仍存在用户，无法删除（可先停用）")
    name = c.name
    db.delete(c)
    write_log(db, "org_change", admin, f"删除专业学院：{name}", request=request)
    db.commit()
    return {"message": "已删除"}


@router.post("/api/admin/departments")
def create_department(
    payload: DepartmentIn,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """新增下设部门；同学院下名称唯一"""
    name = payload.name.strip()
    if not name:
        raise HTTPException(status_code=400, detail="部门名称不能为空")
    college = db.query(College).filter(College.id == payload.college_id).first()
    if college is None:
        raise HTTPException(status_code=400, detail="所属学院不存在")
    if db.query(Department).filter(Department.college_id == college.id, Department.name == name).first():
        raise HTTPException(status_code=400, detail="该学院下已存在同名部门")
    d = Department(college_id=college.id, name=name, code=payload.code.strip())
    db.add(d)
    write_log(db, "org_change", admin, f"在[{college.name}]下新增部门：{name}", request=request)
    db.commit()
    db.refresh(d)
    return {"id": d.id, "name": d.name, "code": d.code, "status": d.status, "college_id": d.college_id}


@router.put("/api/admin/departments/{department_id}")
def update_department(
    department_id: int,
    payload: DepartmentUpdate,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """部门改名 / 启用停用；停用后其物资停止挂牌（管理员可在物资管理重新挂牌）"""
    d = db.query(Department).filter(Department.id == department_id).first()
    if d is None:
        raise HTTPException(status_code=404, detail="部门不存在")
    changes = []

    if payload.college_id is not None and payload.college_id != d.college_id:
        college = db.query(College).filter(College.id == payload.college_id).first()
        if college is None:
            raise HTTPException(status_code=400, detail="目标学院不存在")
        changes.append(f"调整所属学院 -> {college.name}")
        d.college_id = college.id

    if payload.name is not None and payload.name.strip() and payload.name.strip() != d.name:
        if (
            db.query(Department)
            .filter(Department.college_id == d.college_id, Department.name == payload.name.strip(), Department.id != d.id)
            .first()
        ):
            raise HTTPException(status_code=400, detail="该学院下已存在同名部门")
        changes.append(f"改名 {d.name} -> {payload.name.strip()}")
        d.name = payload.name.strip()

    if payload.code is not None and payload.code != d.code:
        changes.append(f"编码 {d.code} -> {payload.code}")
        d.code = payload.code

    if payload.status is not None and payload.status in ("active", "disabled") and payload.status != d.status:
        changes.append(f"状态 {d.status} -> {payload.status}")
        d.status = payload.status
        affected = db.query(Asset).filter(Asset.department_id == d.id).all()
        if payload.status == "disabled":
            # 部门停用：其物资一并停用（不占用平台货架）
            for a in affected:
                a.status = "disabled"
        else:
            # 部门重新启用：只把因停用而停用的物资恢复挂牌，
            # 且严格遵守「剩余 = 0 自动下架」——已领完的物资不能因为部门启用又被挂回去
            for a in affected:
                if a.status != "disabled":
                    continue  # 正常上架/已下架的物资保持原状
                a.status = "on" if a.remaining_count > 0 else "off"

    if not changes:
        return {"id": d.id, "name": d.name, "code": d.code, "status": d.status, "message": "无变更"}

    write_log(db, "org_change", admin, f"修改部门[{d.name}]：" + "；".join(changes), request=request)
    db.commit()
    return {"id": d.id, "name": d.name, "code": d.code, "status": d.status, "college_id": d.college_id}


@router.delete("/api/admin/departments/{department_id}")
def delete_department(
    department_id: int,
    request: Request,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """删除部门；存在用户或物资时拒绝"""
    d = db.query(Department).filter(Department.id == department_id).first()
    if d is None:
        raise HTTPException(status_code=404, detail="部门不存在")
    if db.query(User).filter(User.department_id == d.id).count() > 0:
        raise HTTPException(status_code=400, detail="该部门下仍存在用户，无法删除（可先停用）")
    if db.query(Asset).filter(Asset.department_id == d.id).count() > 0:
        raise HTTPException(status_code=400, detail="该部门下仍存在物资，无法删除（可先停用）")
    name = d.name
    db.delete(d)
    write_log(db, "org_change", admin, f"删除部门：{name}", request=request)
    db.commit()
    return {"message": "已删除"}
