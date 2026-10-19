# -*- coding: utf-8 -*-
"""
路由：日志中心（管理员）
------------------------------------------------------------------
负责接口：
  GET /api/admin/logs        日志查询（时间、用户、工号、部门、资产编号、操作类型筛选）
  GET /api/admin/logs/types  操作类型字典（供前端下拉使用）
  GET /api/admin/logs/export 日志导出 CSV（UTF-8 BOM，Excel 可直接打开）
说明：日志只可查看与导出，系统不提供任何删除/修改接口。
依赖页面：frontend/admin/logs.html
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import StreamingResponse
from sqlalchemy import desc
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import require_admin
from ..models import Log, User

router = APIRouter(prefix="/api/admin/logs", tags=["日志中心"])

# 操作类型 -> 中文说明
TYPE_LABELS = {
    "login": "登录/退出",
    "publish": "发布物资",
    "update": "修改物资",
    "off": "下架物资",
    "relist": "重新挂牌",
    "claim": "认领流转",
    "claim_revoke": "撤销认领",
    "image_upload": "图片上传/复核",
    "image_reject": "图片驳回",
    "org_change": "组织机构变更",
    "user_change": "用户/工号变更",
    "handover_gen": "生成交接单",
    "handover_print": "打印交接单",
    "handover_export": "导出交接单",
}


@router.get("/types")
def log_types(admin: User = Depends(require_admin)):
    """返回操作类型字典"""
    return [{"value": k, "label": v} for k, v in TYPE_LABELS.items()]


@router.get("")
def list_logs(
    type: str = "",
    operator: str = "",
    emp_no: str = "",
    dept: str = "",
    asset_no: str = "",
    start: Optional[str] = None,
    end: Optional[str] = None,
    limit: int = 500,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """日志查询；默认返回最近 500 条"""
    q = db.query(Log)
    if type.strip():
        q = q.filter(Log.type == type.strip())
    if operator.strip():
        q = q.filter(Log.operator_name.like(f"%{operator.strip()}%"))
    if emp_no.strip():
        q = q.filter(Log.emp_no.like(f"%{emp_no.strip()}%"))
    if dept.strip():
        q = q.filter(Log.dept_name.like(f"%{dept.strip()}%"))
    if asset_no.strip():
        q = q.filter(Log.asset_no.like(f"%{asset_no.strip()}%"))
    if start:
        q = q.filter(Log.time >= f"{start} 00:00:00")
    if end:
        q = q.filter(Log.time <= f"{end} 23:59:59")

    logs = q.order_by(desc(Log.time), desc(Log.id)).limit(limit).all()
    return [
        {
            "id": l.id,
            "type": l.type,
            "type_label": TYPE_LABELS.get(l.type, l.type),
            "operator_name": l.operator_name,
            "emp_no": l.emp_no,
            "dept_name": l.dept_name,
            "asset_no": l.asset_no,
            "quantity": l.quantity,
            "time": l.time.strftime("%Y-%m-%d %H:%M:%S") if l.time else "",
            "detail": l.detail,
            "ip": l.ip,
        }
        for l in logs
    ]


@router.get("/export")
def export_logs(
    type: str = "",
    operator: str = "",
    emp_no: str = "",
    dept: str = "",
    asset_no: str = "",
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: Session = Depends(get_db),
    admin: User = Depends(require_admin),
):
    """导出日志为 CSV（与查询条件一致）"""
    q = db.query(Log)
    if type.strip():
        q = q.filter(Log.type == type.strip())
    if operator.strip():
        q = q.filter(Log.operator_name.like(f"%{operator.strip()}%"))
    if emp_no.strip():
        q = q.filter(Log.emp_no.like(f"%{emp_no.strip()}%"))
    if dept.strip():
        q = q.filter(Log.dept_name.like(f"%{dept.strip()}%"))
    if asset_no.strip():
        q = q.filter(Log.asset_no.like(f"%{asset_no.strip()}%"))
    if start:
        q = q.filter(Log.time >= f"{start} 00:00:00")
    if end:
        q = q.filter(Log.time <= f"{end} 23:59:59")
    logs = q.order_by(desc(Log.time), desc(Log.id)).all()

    import csv
    import io

    buf = io.StringIO()
    buf.write("\ufeff")  # BOM，避免 Excel 中文乱码
    writer = csv.writer(buf)
    writer.writerow(["日志ID", "操作类型", "操作人", "工号", "部门", "资产编号", "数量", "时间", "详情", "IP/终端"])
    for l in logs:
        writer.writerow(
            [
                l.id,
                TYPE_LABELS.get(l.type, l.type),
                l.operator_name,
                l.emp_no,
                l.dept_name,
                l.asset_no,
                l.quantity if l.quantity is not None else "",
                l.time.strftime("%Y-%m-%d %H:%M:%S") if l.time else "",
                l.detail,
                l.ip,
            ]
        )
    buf.seek(0)
    filename = f"logs_{datetime.now().strftime('%Y%m%d%H%M%S')}.csv"
    return StreamingResponse(
        iter([buf.getvalue()]),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )
