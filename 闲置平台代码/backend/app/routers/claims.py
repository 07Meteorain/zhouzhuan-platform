# -*- coding: utf-8 -*-
"""
路由：认领与流转记录
------------------------------------------------------------------
负责接口：
  POST /api/claims                认领物资（数量 ≤ 剩余，实时扣减，归零自动下架）
  GET  /api/claims/mine           我的认领（direction=in 转入 / out 转出 / all）
  GET  /api/claims                流转记录查询（支持资产编号、名称、对方部门、时间、物资ID）
  POST /api/claims/{id}/revoke    管理员撤销认领（恢复数量并留痕，仅管理员）
依赖页面：frontend/user/asset.html（认领表单）、frontend/user/records.html、
          frontend/user/home.html（我的认领）、frontend/admin/assets.html（撤销认领）
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import claim_dict, full_dept_name, get_current_user, require_admin, write_log
from ..models import Asset, Claim, College, Department, User
from ..schemas import ClaimIn

router = APIRouter(prefix="/api/claims", tags=["认领与流转"])


@router.post("")
def create_claim(
    payload: ClaimIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    认领物资。规则：
      - 认领数量 ≤ 剩余；剩余 = 总数 − 已认领
      - 剩余 > 0 继续挂牌；剩余 = 0 自动下架
      - 记录认领人姓名/工号/部门/时间，并生成流转记录
    """
    if current_user.role != "user":
        raise HTTPException(status_code=403, detail="管理员不参与发布与认领")
    if current_user.department_id is None:
        raise HTTPException(status_code=403, detail="当前账号未关联部门，无法认领")

    asset = db.query(Asset).filter(Asset.id == payload.asset_id).first()
    if asset is None:
        raise HTTPException(status_code=404, detail="物资不存在")
    if asset.status != "on":
        raise HTTPException(status_code=400, detail="该物资已下架，不可认领")
    if payload.quantity <= 0:
        raise HTTPException(status_code=400, detail="认领数量必须为大于 0 的正整数")
    if payload.quantity > asset.remaining_count:
        raise HTTPException(
            status_code=400,
            detail=f"认领数量 {payload.quantity} 超过剩余数量 {asset.remaining_count}",
        )
    # 接收部门：默认认领人所属部门，可指定其他启用中的部门代收
    to_college_id = current_user.college_id
    to_dept_id = current_user.department_id
    if payload.receiver_department_id:
        dept = db.query(Department).filter(Department.id == payload.receiver_department_id).first()
        if dept is None:
            raise HTTPException(status_code=400, detail="所选接收部门不存在")
        if dept.college_id != (payload.receiver_college_id or dept.college_id):
            raise HTTPException(status_code=400, detail="所选接收部门与学院不匹配")
        if dept.status != "active":
            raise HTTPException(status_code=400, detail="所选接收部门已停用，无法接收")
        college = db.query(College).filter(College.id == dept.college_id).first()
        if college is None or college.status != "active":
            raise HTTPException(status_code=400, detail="所选接收学院已停用，无法接收")
        to_college_id, to_dept_id = dept.college_id, dept.id

    from_name = full_dept_name(db, asset.college_id, asset.department_id)
    to_name = full_dept_name(db, to_college_id, to_dept_id)
    delegated = to_dept_id != current_user.department_id

    claim = Claim(
        asset_id=asset.id,
        asset_no=asset.asset_no,
        asset_name=asset.name,
        unit=asset.unit,
        quantity=payload.quantity,
        from_college_id=asset.college_id,
        from_dept_id=asset.department_id,
        from_dept_name=from_name,
        to_college_id=to_college_id,
        to_dept_id=to_dept_id,
        to_dept_name=to_name,
        receiver_name=payload.receiver_name.strip(),
        receiver_emp_no=payload.receiver_emp_no.strip(),
        receiver_phone=payload.receiver_phone.strip(),
        remark=payload.remark.strip(),
        claimer_id=current_user.id,
        status="normal",
    )
    db.add(claim)

    # 实时扣减
    asset.claimed_count += payload.quantity
    asset.remaining_count = asset.total_count - asset.claimed_count
    if asset.remaining_count == 0:
        asset.status = "off"

    write_log(
        db,
        "claim",
        current_user,
        f"认领物资：{asset.name}（编号 {asset.asset_no}）{payload.quantity}{asset.unit}，"
        f"{from_name} 转出 -> {to_name} 转入，接收人 {claim.receiver_name}（{claim.receiver_emp_no}）"
        + (f"；代接收：操作人所属 {full_dept_name(db, current_user.college_id, current_user.department_id)}" if delegated else ""),
        asset_no=asset.asset_no,
        quantity=payload.quantity,
        request=request,
    )
    db.commit()
    db.refresh(claim)
    return {
        "claim": claim_dict(db, claim),
        "asset": {
            "id": asset.id,
            "remaining_count": asset.remaining_count,
            "claimed_count": asset.claimed_count,
            "status": asset.status,
        },
    }


@router.get("")
def list_claims(
    asset_no: str = "",
    asset_name: str = "",
    dept: str = "",
    asset_id: Optional[int] = None,
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """流转记录查询：支持资产编号、资产名称、涉及部门、时间区间、物资ID"""
    q = db.query(Claim)
    if asset_id:
        q = q.filter(Claim.asset_id == asset_id)
    if asset_no.strip():
        q = q.filter(Claim.asset_no.like(f"%{asset_no.strip()}%"))
    if asset_name.strip():
        q = q.filter(Claim.asset_name.like(f"%{asset_name.strip()}%"))
    if dept.strip():
        kw = f"%{dept.strip()}%"
        q = q.filter(Claim.from_dept_name.like(kw) | Claim.to_dept_name.like(kw))
    if start:
        q = q.filter(Claim.claim_time >= f"{start} 00:00:00")
    if end:
        q = q.filter(Claim.claim_time <= f"{end} 23:59:59")
    claims = q.order_by(Claim.claim_time.desc(), Claim.id.desc()).all()
    return [claim_dict(db, c) for c in claims]


@router.get("/mine")
def my_claims(
    direction: str = "in",
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    我的记录：
      direction=in  本部门转入历史（我认领别人的）
      direction=out 本部门转出历史（别人认领我的）
      direction=all 全部
    """
    dept_id = current_user.department_id
    q = db.query(Claim)
    if direction == "in":
        q = q.filter(Claim.to_dept_id == dept_id)
    elif direction == "out":
        q = q.filter(Claim.from_dept_id == dept_id)
    claims = q.order_by(Claim.claim_time.desc(), Claim.id.desc()).all()
    return [claim_dict(db, c) for c in claims]


@router.post("/{claim_id}/revoke")
def revoke_claim(
    claim_id: int,
    reason: str = "",
    request: Request = None,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """管理员撤销认领：恢复物资数量（如已下架则自动重新上架），全程留痕"""
    c = db.query(Claim).filter(Claim.id == claim_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="认领记录不存在")
    if c.status == "revoked":
        raise HTTPException(status_code=400, detail="该认领记录已撤销")

    asset = db.query(Asset).filter(Asset.id == c.asset_id).first()
    if asset:
        asset.claimed_count = max(0, asset.claimed_count - c.quantity)
        asset.remaining_count = asset.total_count - asset.claimed_count
        if asset.remaining_count > 0 and asset.status != "on":
            asset.status = "on"  # 撤销后重新挂牌
        if asset.remaining_count == 0:
            asset.status = "off"

    c.status = "revoked"
    write_log(
        db,
        "claim_revoke",
        admin,
        f"撤销认领记录 #{c.id}：{c.asset_name}（{c.asset_no}）{c.quantity}{c.unit}，"
        f"{c.from_dept_name} -> {c.to_dept_name}"
        + (f"，原因：{reason.strip()}" if reason and reason.strip() else ""),
        asset_no=c.asset_no,
        quantity=c.quantity,
        request=request,
    )
    db.commit()
    return claim_dict(db, c)
