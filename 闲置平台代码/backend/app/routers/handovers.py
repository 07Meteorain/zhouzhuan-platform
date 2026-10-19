# -*- coding: utf-8 -*-
"""
路由：交接单
------------------------------------------------------------------
负责接口：
  POST /api/handovers                  生成交接单（按认领记录，单号唯一，重复生成返回原单）
  GET  /api/handovers                  交接单列表（按资产编号、部门、时间查询）
  GET  /api/handovers/{handover_no}    交接单详情（含全部资产字段 + 签字栏数据）
  POST /api/handovers/{handover_no}/print  记录打印日志（前端 window.print() 调用）
  GET  /api/handovers/{handover_no}/export 导出交接单文件（?format=docx|pdf，服务端真实生成）
依赖页面：frontend/user/handover.html、frontend/user/records.html
"""
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from sqlalchemy import desc
from sqlalchemy.orm import Session

from ..database import get_db
from ..deps import get_current_user, write_log
from ..models import Asset, Claim, Handover, User
from ..schemas import HandoverIn

router = APIRouter(prefix="/api/handovers", tags=["交接单"])


def _gen_no(db: Session) -> str:
    """生成交接单号：JJ + 年月日 + 4 位序号，保证平台上唯一"""
    today = datetime.now().strftime("%Y%m%d")
    prefix = f"JJ{today}"
    last = (
        db.query(Handover)
        .filter(Handover.handover_no.like(f"{prefix}%"))
        .order_by(desc(Handover.id))
        .first()
    )
    seq = 1
    if last and last.handover_no.startswith(prefix):
        try:
            seq = int(last.handover_no[len(prefix):]) + 1
        except Exception:
            seq = 1
    return f"{prefix}{seq:04d}"


def _handover_detail(db: Session, h: Handover) -> dict:
    """拼接交接单完整内容：资产字段 + 流转双方 + 接收人 + 签字栏"""
    c = db.query(Claim).filter(Claim.id == h.claim_id).first()
    a = db.query(Asset).filter(Asset.id == h.asset_id).first()
    base = {
        "id": h.id,
        "handover_no": h.handover_no,
        "claim_id": h.claim_id,
        "asset_id": h.asset_id,
        "generated_by_name": h.generated_by_name,
        "generated_time": h.generated_time.strftime("%Y-%m-%d %H:%M:%S") if h.generated_time else "",
        "print_count": h.print_count,
    }
    if not c:
        return base

    return {
        **base,
        # 资产信息
        "asset_no": c.asset_no,
        "asset_name": c.asset_name,
        "unit": c.unit,
        "quantity": c.quantity,
        "category": a.category if a else "",
        "spec": a.spec if a else "",
        "condition_desc": a.condition_desc if a else "",
        # 使用管理
        "using_person": a.using_person if a else "",
        "usage_direction": a.usage_direction if a else "",
        "manage_dept": a.manage_dept if a else "",
        # 存放联系
        "location": a.location if a else "",
        "contact_person": a.contact_person if a else "",
        "contact_emp_no": a.contact_emp_no if a else "",
        "contact_phone": a.contact_phone if a else "",
        # 流转双方
        "from_dept_name": c.from_dept_name,
        "to_dept_name": c.to_dept_name,
        "receiver_name": c.receiver_name,
        "receiver_emp_no": c.receiver_emp_no,
        "receiver_phone": c.receiver_phone,
        "claim_time": c.claim_time.strftime("%Y-%m-%d %H:%M:%S") if c.claim_time else "",
        "remark": c.remark,
        "status": c.status,
    }


@router.post("")
def create_handover(
    payload: HandoverIn,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """生成交接单：一次认领对应一张单；已生成则直接返回，避免重复单号"""
    c = db.query(Claim).filter(Claim.id == payload.claim_id).first()
    if c is None:
        raise HTTPException(status_code=404, detail="认领记录不存在")

    # 权限：仅流转双方部门或管理员可生成
    if current_user.role != "admin":
        if current_user.department_id not in (c.from_dept_id, c.to_dept_id):
            raise HTTPException(status_code=403, detail="仅流转双方部门可生成该交接单")

    exist = db.query(Handover).filter(Handover.claim_id == c.id).first()
    if exist:
        return _handover_detail(db, exist)

    h = Handover(
        handover_no=_gen_no(db),
        claim_id=c.id,
        asset_id=c.asset_id,
        generated_by=current_user.id,
        generated_by_name=current_user.name,
        print_count=0,
    )
    db.add(h)
    db.flush()
    c.handover_no = h.handover_no
    write_log(
        db,
        "handover_gen",
        current_user,
        f"生成交接单 {h.handover_no}：{c.asset_name}（{c.asset_no}）{c.quantity}{c.unit}，"
        f"{c.from_dept_name} -> {c.to_dept_name}",
        asset_no=c.asset_no,
        quantity=c.quantity,
        request=request,
    )
    db.commit()
    db.refresh(h)
    return _handover_detail(db, h)


@router.get("")
def list_handovers(
    asset_no: str = "",
    dept: str = "",
    start: Optional[str] = None,
    end: Optional[str] = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """交接单列表查询"""
    q = db.query(Handover)
    if asset_no.strip() or dept.strip() or start or end:
        q = q.join(Claim, Handover.claim_id == Claim.id)
        if asset_no.strip():
            q = q.filter(Claim.asset_no.like(f"%{asset_no.strip()}%"))
        if dept.strip():
            kw = f"%{dept.strip()}%"
            q = q.filter(Claim.from_dept_name.like(kw) | Claim.to_dept_name.like(kw))
        if start:
            q = q.filter(Claim.claim_time >= f"{start} 00:00:00")
        if end:
            q = q.filter(Claim.claim_time <= f"{end} 23:59:59")
    hs = q.order_by(desc(Handover.id)).all()
    return [_handover_detail(db, h) for h in hs]


@router.get("/{handover_no}")
def get_handover(
    handover_no: str,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """交接单详情"""
    h = db.query(Handover).filter(Handover.handover_no == handover_no).first()
    if h is None:
        raise HTTPException(status_code=404, detail="交接单不存在")
    return _handover_detail(db, h)


@router.get("/{handover_no}/export")
def export_handover(
    handover_no: str,
    format: str = "docx",
    request: Request = None,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    导出交接单文件。
      format=docx  标准 Word 文档（python-docx 生成）
      format=pdf   标准 PDF 文档（reportlab 生成，中文字体自动回退）
    导出同样计入日志中心，便于追溯谁在什么时候导出了哪张单。
    """
    h = db.query(Handover).filter(Handover.handover_no == handover_no).first()
    if h is None:
        raise HTTPException(status_code=404, detail="交接单不存在")

    fmt = (format or "docx").lower()
    if fmt not in ("docx", "pdf"):
        raise HTTPException(status_code=400, detail="导出格式仅支持 docx 或 pdf")

    detail = _handover_detail(db, h)

    try:
        if fmt == "docx":
            from ..export_util import build_docx

            content = build_docx(detail)
            media = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            ext = "docx"
        else:
            from ..export_util import build_pdf

            content = build_pdf(detail)
            media = "application/pdf"
            ext = "pdf"
    except ImportError as e:
        raise HTTPException(
            status_code=500,
            detail=f"导出依赖未安装，请在后端环境执行 pip install python-docx reportlab（{e}）",
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"导出失败：{e}")

    claim = db.query(Claim).filter(Claim.id == h.claim_id).first()
    write_log(
        db,
        "handover_export",
        current_user,
        f"导出交接单 {h.handover_no}（{ext.upper()} 文件）",
        asset_no=claim.asset_no if claim else "",
        request=request,
    )
    db.commit()

    filename = f"交接单_{h.handover_no}.{ext}"
    # 中文文件名需按 RFC 5987 编码，否则浏览器下载后文件名乱码
    encoded = filename.encode("utf-8")
    return Response(
        content=content,
        media_type=media,
        headers={
            "Content-Disposition": "attachment; filename=\"handover.%s\"; filename*=UTF-8''%s"
            % (ext, "".join("%%%02X" % b for b in encoded))
        },
    )


@router.post("/{handover_no}/print")
def log_print(
    handover_no: str,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """记录打印日志（前端点击打印按钮时调用，与 window.print() 配合使用）"""
    h = db.query(Handover).filter(Handover.handover_no == handover_no).first()
    if h is None:
        raise HTTPException(status_code=404, detail="交接单不存在")
    h.print_count += 1
    claim = db.query(Claim).filter(Claim.id == h.claim_id).first()
    write_log(
        db,
        "handover_print",
        current_user,
        f"打印交接单 {h.handover_no}（第 {h.print_count} 次）",
        asset_no=claim.asset_no if claim else "",
        request=request,
    )
    db.commit()
    return {"handover_no": h.handover_no, "print_count": h.print_count}
