# -*- coding: utf-8 -*-
"""
路由：统计报表（管理员）
------------------------------------------------------------------
负责接口：
  GET /api/admin/stats/overview    总览：物资数、上架数、下架数、认领笔数、流转总量
  GET /api/admin/stats/assets      按资产维度：发布/认领/剩余/状态
  GET /api/admin/stats/departments 按部门维度：转出数量、转入数量
  GET /api/admin/stats/export      导出 CSV（type=assets|departments）
所有数据实时聚合自数据库，无任何预置假数据。
依赖页面：frontend/admin/stats.html
"""
import csv
import io
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import full_dept_name, require_admin
from ..models import Asset, Claim, College, Department, User

router = APIRouter(prefix="/api/admin/stats", tags=["统计报表"])


@router.get("/overview")
def overview(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """平台总览指标"""
    total_assets = db.query(Asset).count()
    on_assets = db.query(Asset).filter(Asset.status == "on").count()
    off_assets = db.query(Asset).filter(Asset.status == "off").count()
    disabled_assets = db.query(Asset).filter(Asset.status == "disabled").count()
    claims = db.query(Claim).filter(Claim.status == "normal").all()
    return {
        "asset_total": total_assets,
        "asset_on": on_assets,
        "asset_off": off_assets,
        "asset_disabled": disabled_assets,
        "claim_count": len(claims),
        "transfer_quantity": sum(c.quantity for c in claims),
        "college_count": db.query(College).count(),
        "department_count": db.query(Department).count(),
        "user_count": db.query(User).count(),
    }


@router.get("/assets")
def stats_assets(
    keyword: str = "",
    manage_dept: str = "",
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """按资产维度统计发布/认领/剩余/状态"""
    q = db.query(Asset)
    if keyword.strip():
        kw = f"%{keyword.strip()}%"
        q = q.filter(Asset.name.like(kw) | Asset.asset_no.like(kw))
    if manage_dept.strip():
        q = q.filter(Asset.manage_dept.like(f"%{manage_dept.strip()}%"))
    if start:
        q = q.filter(Asset.publish_time >= f"{start} 00:00:00")
    if end:
        q = q.filter(Asset.publish_time <= f"{end} 23:59:59")

    rows = []
    for a in q.order_by(Asset.publish_time.desc(), Asset.id.desc()).all():
        rows.append(
            {
                "asset_no": a.asset_no,
                "asset_name": a.name,
                "category": a.category,
                "unit": a.unit,
                "manage_dept": a.manage_dept,
                "total_count": a.total_count,
                "claimed_count": a.claimed_count,
                "remaining_count": a.remaining_count,
                "status": a.status,
                "dept_full_name": full_dept_name(db, a.college_id, a.department_id),
                "publish_time": a.publish_time.strftime("%Y-%m-%d %H:%M:%S") if a.publish_time else "",
            }
        )
    return rows


@router.get("/departments")
def stats_departments(db: Session = Depends(get_db), admin: User = Depends(require_admin)):
    """按部门维度统计转出/转入数量"""
    depts = db.query(Department).order_by(Department.id).all()
    rows = []
    for d in depts:
        out_qty = (
            db.query(Claim)
            .filter(Claim.from_dept_id == d.id, Claim.status == "normal")
            .all()
        )
        in_qty = db.query(Claim).filter(Claim.to_dept_id == d.id, Claim.status == "normal").all()
        rows.append(
            {
                "department_id": d.id,
                "department_name": d.name,
                "dept_full_name": full_dept_name(db, d.college_id, d.id),
                "college_name": (db.query(College).filter(College.id == d.college_id).first() or College(name="")).name,
                "status": d.status,
                "out_quantity": sum(c.quantity for c in out_qty),
                "out_count": len(out_qty),
                "in_quantity": sum(c.quantity for c in in_qty),
                "in_count": len(in_qty),
                "published_assets": db.query(Asset).filter(Asset.department_id == d.id).count(),
            }
        )
    return rows


@router.get("/export")
def export_stats(
    type: str = "assets",
    keyword: str = "",
    manage_dept: str = "",
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """导出统计报表为 CSV"""
    buf = io.StringIO()
    buf.write("\ufeff")
    writer = csv.writer(buf)

    if type == "departments":
        writer.writerow(["学院", "部门", "转出笔数", "转出数量", "转入笔数", "转入数量", "发布物资数", "状态"])
        for r in stats_departments(db=db, admin=admin):
            writer.writerow(
                [
                    r["college_name"],
                    r["department_name"],
                    r["out_count"],
                    r["out_quantity"],
                    r["in_count"],
                    r["in_quantity"],
                    r["published_assets"],
                    r["status"],
                ]
            )
    else:
        writer.writerow(
            ["资产编号", "资产名称", "分类", "计量单位", "使用管理部门", "发布部门", "总数", "已认领", "剩余", "状态", "发布时间"]
        )
        for r in stats_assets(
            keyword=keyword, manage_dept=manage_dept, start=start, end=end, db=db, admin=admin
        ):
            writer.writerow(
                [
                    r["asset_no"],
                    r["asset_name"],
                    r["category"],
                    r["unit"],
                    r["manage_dept"],
                    r["dept_full_name"],
                    r["total_count"],
                    r["claimed_count"],
                    r["remaining_count"],
                    r["status"],
                    r["publish_time"],
                ]
            )

    buf.seek(0)
    filename = f"stats_{type}_{datetime.now().strftime('%Y%m%d%H%M%S')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
