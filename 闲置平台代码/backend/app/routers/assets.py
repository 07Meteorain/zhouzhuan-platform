# -*- coding: utf-8 -*-
"""
路由：物资（公共资产闲置平台共享池核心）
------------------------------------------------------------------
部门用户接口：
  POST /api/assets                     发布物资（multipart：表单字段 + 多张真实图片），提交即上架
  GET  /api/assets                     平台浏览/搜索（名称、编号、分类、学院、部门、管理部门、存放地点、剩余范围、排序）
  GET  /api/assets/{id}                物资详情（全字段 + 图片说明卡片 + 流转记录）
  GET  /api/assets/mine                我的发布
  PUT  /api/assets/{id}                修改本部门物资（留痕）
  POST /api/assets/{id}/unlist         主动下架
  POST /api/assets/{id}/relist         重新挂牌（下架/停用后再次挂回平台）
  POST /api/assets/{id}/images         追加图片
  PUT  /api/assets/{id}/images/{image_id}/cover   设为首图
  DELETE /api/assets/{id}/images/{image_id}       删除图片
  GET  /api/assets/meta/options        分类/管理部门/存放地点等筛选项（来自真实数据，无写死）
管理员接口：
  GET  /api/admin/assets               全量物资（含被驳回图片）
  PUT  /api/admin/assets/{id}          修正异常物资（资产编号唯一校验、数量规则、逐字段留痕）
  POST /api/admin/assets/{id}/force-off          强制下架
  POST /api/admin/assets/{id}/relist             重新挂牌
  POST /api/admin/assets/{id}/images/{image_id}/reject  驳回图片
  POST /api/admin/assets/{id}/images/{image_id}/restore 撤销驳回
依赖页面：frontend/user/publish.html、browse.html、asset.html、frontend/admin/assets.html
"""
import os
import re
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from sqlalchemy import or_
from sqlalchemy.orm import Session

from ..config import MAX_IMAGE_COUNT, UPLOAD_DIR
from ..database import get_db
from ..deps import asset_dict, full_dept_name, get_current_user, require_admin, write_log
from ..image_util import ImageRejected, save_image
from ..models import Asset, AssetImage, Claim, College, Department, User
from ..schemas import AdminAssetUpdate, AssetUpdate, ImageCaptionIn, ImageRejectIn  # noqa: F401


def _watermark_text(dept_full: str, asset_no: str) -> str:
    """水印文案：部门 + 资产编号 + 拍摄/上传时间"""
    return f"{dept_full} · {asset_no} · {datetime.now().strftime('%Y-%m-%d %H:%M')}"

router = APIRouter(tags=["物资"])

# 联系电话格式：手机号 或 固话（如 010-12345678）
PHONE_RE = re.compile(r"1[3-9]\d{9}|\d{3,4}-?\d{7,8}")


def _get_asset_or_404(db: Session, asset_id: int) -> Asset:
    a = db.query(Asset).filter(Asset.id == asset_id).first()
    if a is None:
        raise HTTPException(status_code=404, detail="物资不存在")
    return a


def _check_owner(db: Session, asset: Asset, user: User) -> None:
    """部门用户只能维护本部门发布的数据"""
    if user.role == "admin":
        return
    if asset.department_id != user.department_id:
        raise HTTPException(status_code=403, detail="仅发布部门可维护该物资")


def _recalc(asset: Asset) -> None:
    """数量规则：总数 − 已认领 = 剩余；剩余=0 自动下架；不允许为负"""
    if asset.claimed_count < 0:
        asset.claimed_count = 0
    if asset.total_count < asset.claimed_count:
        raise HTTPException(
            status_code=400,
            detail=f"总数不能小于已认领数量（已认领 {asset.claimed_count}）",
        )
    asset.remaining_count = asset.total_count - asset.claimed_count
    if asset.remaining_count == 0 and asset.status == "on":
        asset.status = "off"


def _require_active_dept(user: User) -> None:
    """部门停用：限制发布，保留查询"""
    if user.role == "admin":
        return
    if user.role == "user" and (user.college_id is None or user.department_id is None):
        raise HTTPException(status_code=403, detail="当前账号未关联部门，无法发布")


# ------------------------------ 发布物资 ------------------------------

@router.post("/api/assets")
async def create_asset(
    request: Request,
    asset_no: str = Form(...),
    name: str = Form(...),
    category: str = Form(""),
    unit: str = Form("件"),
    spec: str = Form(""),
    total_count: int = Form(...),
    condition_desc: str = Form(""),
    remark: str = Form(""),
    using_person: str = Form(""),
    usage_direction: str = Form(""),
    manage_dept: str = Form(""),
    location: str = Form(""),
    contact_person: str = Form(""),
    contact_emp_no: str = Form(""),
    contact_phone: str = Form(""),
    college_id: int = Form(...),
    department_id: int = Form(...),
    cover_index: int = Form(0),
    captions: str = Form(""),
    files: List[UploadFile] = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """
    发布物资。校验：必填完整 / 资产编号唯一 / 总数正整数 / 至少 1 张真实图片 /
    学院部门联动有效 / 电话格式 / 工号有效。通过后物资立即上架公共平台。
    """
    if current_user.role != "user":
        raise HTTPException(status_code=403, detail="管理员不参与发布与认领")
    _require_active_dept(current_user)

    asset_no = asset_no.strip()
    name = name.strip()
    if not asset_no:
        raise HTTPException(status_code=400, detail="资产编号不能为空")
    if not name:
        raise HTTPException(status_code=400, detail="资产名称不能为空")
    if db.query(Asset).filter(Asset.asset_no == asset_no).first():
        raise HTTPException(status_code=400, detail=f"资产编号 {asset_no} 已存在，平台内编号必须唯一")
    if total_count <= 0:
        raise HTTPException(status_code=400, detail="总数必须为大于 0 的正整数")

    # 学院 → 部门两级联动有效性校验
    college = db.query(College).filter(College.id == college_id).first()
    dept = db.query(Department).filter(Department.id == department_id).first()
    if college is None:
        raise HTTPException(status_code=400, detail="所选专业学院不存在")
    if dept is None or dept.college_id != college.id:
        raise HTTPException(status_code=400, detail="所选下设部门不属于该学院，请重新选择")
    if college.status != "active" or dept.status != "active":
        raise HTTPException(status_code=403, detail="所选部门已停用，无法发布")

    # 发布主体可调整到任意启用中的学院/部门（默认本部门）。
    # 不限制跨部门：发布人（publisher）与发布部门分别记录，日志中标注代发布关系以便追溯。
    cross_dept = department_id != current_user.department_id

    files = [f for f in files if f and f.filename]
    if not files:
        raise HTTPException(status_code=400, detail="请至少上传 1 张真实照片（仅支持拍照或相册上传）")
    if len(files) > MAX_IMAGE_COUNT:
        raise HTTPException(status_code=400, detail=f"单次最多上传 {MAX_IMAGE_COUNT} 张图片")

    if contact_phone and not PHONE_RE.fullmatch(contact_phone.strip()):
        raise HTTPException(status_code=400, detail="联系电话格式不正确（手机号或固话如 010-12345678）")
    if not contact_emp_no.strip():
        raise HTTPException(status_code=400, detail="联系人工号不能为空")

    # 解析图片说明（JSON 数组，前端按序传入）
    caption_list = []
    if captions.strip():
        try:
            import json

            caption_list = json.loads(captions)
            if not isinstance(caption_list, list):
                caption_list = []
        except Exception:
            caption_list = []

    dept_full = f"{college.name} / {dept.name}"
    asset = Asset(
        asset_no=asset_no,
        name=name,
        category=category.strip(),
        unit=unit.strip() or "件",
        spec=spec.strip(),
        total_count=total_count,
        claimed_count=0,
        remaining_count=total_count,
        condition_desc=condition_desc.strip(),
        remark=remark.strip(),
        using_person=using_person.strip(),
        usage_direction=usage_direction.strip(),
        manage_dept=manage_dept.strip(),
        location=location.strip(),
        contact_person=contact_person.strip(),
        contact_emp_no=contact_emp_no.strip(),
        contact_phone=contact_phone.strip(),
        college_id=college.id,
        department_id=dept.id,
        publisher_id=current_user.id,
        publisher_name=current_user.name,
        publisher_emp_no=current_user.employee_no,
        status="on",
    )
    db.add(asset)
    db.flush()  # 拿到 asset.id 后写图片

    saved_any = False
    try:
        for idx, f in enumerate(files):
            data = await f.read()
            wm_text = _watermark_text(dept_full, asset_no)
            meta = save_image(data, f.filename, db, AssetImage, watermark_text=wm_text)
            img = AssetImage(
                asset_id=asset.id,
                filename=meta["filename"],
                origin_filename=meta["origin_filename"],
                url=meta["url"],
                is_cover=(idx == cover_index) or (cover_index >= len(files) and idx == 0),
                caption=(caption_list[idx] if idx < len(caption_list) else ""),
                uploader_id=current_user.id,
                uploader_name=current_user.name,
                uploader_emp_no=current_user.employee_no,
                uploader_dept=dept_full,
                file_size=meta["file_size"],
                width=meta["width"],
                height=meta["height"],
                sha256=meta["sha256"],
                watermark=meta["watermark"],
            )
            db.add(img)
            saved_any = True
        if not saved_any:
            raise ImageRejected("未成功保存任何图片")
        # 跨部门代发布时明确留痕：发布人所属部门 -> 实际发布部门
        extra = (
            f"；代发布：发布人所属 {full_dept_name(db, current_user.college_id, current_user.department_id)}"
            f" -> 实际发布部门 {dept_full}"
            if cross_dept
            else ""
        )
        write_log(
            db,
            "publish",
            current_user,
            f"发布物资：{name}（编号 {asset_no}，总数 {total_count}，图片 {len(files)} 张）"
            f"，发布主体 {dept_full}{extra}",
            asset_no=asset_no,
            quantity=total_count,
            request=request,
        )
        db.commit()
    except ImageRejected as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    except HTTPException:
        db.rollback()
        raise
    except Exception as e:
        db.rollback()
        raise HTTPException(status_code=500, detail=f"发布失败：{e}")

    db.refresh(asset)
    return asset_dict(db, asset)


# --------------------------- 平台浏览与搜索 ---------------------------

@router.get("/api/assets")
def list_assets(
    keyword: str = "",
    asset_no: str = "",
    category: str = "",
    college_id: Optional[int] = None,
    department_id: Optional[int] = None,
    manage_dept: str = "",
    location: str = "",
    status: str = "",
    min_remaining: Optional[int] = None,
    sort: str = "latest",  # latest | remaining | asset_no
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """公共资产闲置平台：集中展示全部物资，支持多条件搜索与排序"""
    q = db.query(Asset)
    if keyword.strip():
        kw = f"%{keyword.strip()}%"
        q = q.filter(or_(Asset.name.like(kw), Asset.asset_no.like(kw)))
    if asset_no.strip():
        q = q.filter(Asset.asset_no.like(f"%{asset_no.strip()}%"))
    if category.strip():
        q = q.filter(Asset.category == category.strip())
    if college_id:
        q = q.filter(Asset.college_id == college_id)
    if department_id:
        q = q.filter(Asset.department_id == department_id)
    if manage_dept.strip():
        q = q.filter(Asset.manage_dept.like(f"%{manage_dept.strip()}%"))
    if location.strip():
        q = q.filter(Asset.location.like(f"%{location.strip()}%"))
    if status.strip():
        q = q.filter(Asset.status == status.strip())
    if min_remaining is not None:
        q = q.filter(Asset.remaining_count >= int(min_remaining))

    if sort == "remaining":
        q = q.order_by(Asset.remaining_count.desc(), Asset.id.desc())
    elif sort == "asset_no":
        q = q.order_by(Asset.asset_no.asc())
    else:
        q = q.order_by(Asset.publish_time.desc(), Asset.id.desc())

    assets = q.all()
    return [asset_dict(db, a) for a in assets]


@router.get("/api/assets/meta/options")
def asset_options(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """筛选项：分类、管理部门、存放地点，均来自库中真实数据"""
    cats, mds, locs = [], [], []
    for (c,) in db.query(Asset.category).distinct().all():
        if c and c not in cats:
            cats.append(c)
    for (m,) in db.query(Asset.manage_dept).distinct().all():
        if m and m not in mds:
            mds.append(m)
    for (l,) in db.query(Asset.location).distinct().all():
        if l and l not in locs:
            locs.append(l)
    return {"categories": sorted(cats), "manage_depts": sorted(mds), "locations": sorted(locs)}


@router.get("/api/assets/mine")
def list_my_assets(
    db: Session = Depends(get_db), current_user: User = Depends(get_current_user)
):
    """我的发布（当前部门）"""
    if current_user.role != "user":
        raise HTTPException(status_code=403, detail="管理员不参与发布")
    assets = (
        db.query(Asset)
        .filter(Asset.department_id == current_user.department_id)
        .order_by(Asset.publish_time.desc(), Asset.id.desc())
        .all()
    )
    return [asset_dict(db, a) for a in assets]


@router.get("/api/assets/{asset_id}")
def get_asset(
    asset_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """物资详情：全部字段 + 图片说明卡片 + 流转记录"""
    a = _get_asset_or_404(db, asset_id)
    data = asset_dict(db, a)
    claims = (
        db.query(Claim)
        .filter(Claim.asset_id == a.id)
        .order_by(Claim.claim_time.desc(), Claim.id.desc())
        .all()
    )
    from ..deps import claim_dict

    data["transfers"] = [claim_dict(db, c) for c in claims]
    data["can_claim"] = a.status == "on" and a.remaining_count > 0
    return data


@router.put("/api/assets/{asset_id}")
def update_asset(
    asset_id: int,
    payload: AssetUpdate,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """修改本部门物资；总数不可小于已认领；修改留痕"""
    a = _get_asset_or_404(db, asset_id)
    if current_user.role != "user":
        raise HTTPException(status_code=403, detail="管理员不参与发布与认领")
    _check_owner(db, a, current_user)

    changes = []
    mapping = {
        "name": "资产名称",
        "category": "分类",
        "unit": "计量单位",
        "spec": "尺寸规格",
        "total_count": "总数",
        "condition_desc": "成色/状态说明",
        "remark": "备注",
        "using_person": "使用人",
        "usage_direction": "使用方向",
        "manage_dept": "使用的管理部门",
        "location": "存放地点",
        "contact_person": "联系人",
        "contact_emp_no": "联系人工号",
        "contact_phone": "联系电话",
    }
    for field, label in mapping.items():
        val = getattr(payload, field)
        if val is None:
            continue
        old = getattr(a, field)
        if field == "total_count":
            if int(val) <= 0:
                raise HTTPException(status_code=400, detail="总数必须为大于 0 的正整数")
            val = int(val)
        if val != old:
            changes.append(f"{label}：{old} -> {val}")
            setattr(a, field, val)

    if not changes:
        return asset_dict(db, a)

    _recalc(a)
    write_log(
        db,
        "update",
        current_user,
        f"修改物资[{a.asset_no}]：" + "；".join(changes),
        asset_no=a.asset_no,
        request=request,
    )
    db.commit()
    return asset_dict(db, a)


@router.post("/api/assets/{asset_id}/unlist")
def unlist_asset(
    asset_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """主动下架（发布部门）"""
    a = _get_asset_or_404(db, asset_id)
    _check_owner(db, a, current_user)
    if a.status != "on":
        raise HTTPException(status_code=400, detail="当前物资不处于上架状态")
    a.status = "off"
    write_log(db, "off", current_user, f"下架物资：{a.name}（编号 {a.asset_no}）", asset_no=a.asset_no, request=request)
    db.commit()
    return asset_dict(db, a)


@router.post("/api/assets/{asset_id}/relist")
def relist_asset(
    asset_id: int,
    request: Request,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """重新挂牌：下架或停用部门的物资可重新挂回公共平台"""
    a = _get_asset_or_404(db, asset_id)
    _check_owner(db, a, current_user)
    if a.remaining_count <= 0:
        raise HTTPException(status_code=400, detail="剩余数量为 0，无法重新挂牌")
    if a.status == "on":
        raise HTTPException(status_code=400, detail="物资已处于上架状态")
    a.status = "on"
    write_log(db, "relist", current_user, f"重新挂牌物资：{a.name}（编号 {a.asset_no}）", asset_no=a.asset_no, request=request)
    db.commit()
    return asset_dict(db, a)


# ------------------------------ 图片管理 ------------------------------

@router.post("/api/assets/{asset_id}/images")
async def add_images(
    asset_id: int,
    request: Request,
    files: List[UploadFile] = File(...),
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """追加图片（真实性校验同发布）；仅本部门可操作"""
    a = _get_asset_or_404(db, asset_id)
    _check_owner(db, a, current_user)
    files = [f for f in files if f and f.filename]
    if not files:
        raise HTTPException(status_code=400, detail="请选择要上传的真实照片")
    has_cover = any(i.is_cover for i in a.images)
    try:
        for idx, f in enumerate(files):
            data = await f.read()
            dept_full = full_dept_name(db, a.college_id, a.department_id)
            wm_text = _watermark_text(dept_full, a.asset_no)
            meta = save_image(data, f.filename, db, AssetImage, watermark_text=wm_text)
            db.add(
                AssetImage(
                    asset_id=a.id,
                    filename=meta["filename"],
                    origin_filename=meta["origin_filename"],
                    url=meta["url"],
                    is_cover=(not has_cover and idx == 0),
                    uploader_id=current_user.id,
                    uploader_name=current_user.name,
                    uploader_emp_no=current_user.employee_no,
                    uploader_dept=dept_full,
                    file_size=meta["file_size"],
                    width=meta["width"],
                    height=meta["height"],
                    sha256=meta["sha256"],
                    watermark=meta["watermark"],
                )
            )
        write_log(db, "image_upload", current_user, f"为物资[{a.asset_no}]追加 {len(files)} 张图片", asset_no=a.asset_no, request=request)
        db.commit()
    except ImageRejected as e:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(e))
    db.refresh(a)
    return asset_dict(db, a)


@router.put("/api/assets/{asset_id}/images/{image_id}/cover")
def set_cover(
    asset_id: int,
    image_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """设置首图"""
    a = _get_asset_or_404(db, asset_id)
    _check_owner(db, a, current_user)
    target = None
    for i in a.images:
        i.is_cover = i.id == image_id
        if i.id == image_id:
            target = i
    if target is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    db.commit()
    return asset_dict(db, a)


@router.put("/api/assets/{asset_id}/images/{image_id}/caption")
def set_caption(
    asset_id: int,
    image_id: int,
    payload: ImageCaptionIn,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """修改图片说明"""
    a = _get_asset_or_404(db, asset_id)
    _check_owner(db, a, current_user)
    img = db.query(AssetImage).filter(AssetImage.id == image_id, AssetImage.asset_id == a.id).first()
    if img is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    img.caption = payload.caption.strip()
    db.commit()
    return asset_dict(db, a)


@router.delete("/api/assets/{asset_id}/images/{image_id}")
def delete_image(
    asset_id: int,
    image_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
):
    """删除图片；至少保留 1 张"""
    a = _get_asset_or_404(db, asset_id)
    _check_owner(db, a, current_user)
    img = db.query(AssetImage).filter(AssetImage.id == image_id, AssetImage.asset_id == a.id).first()
    if img is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    if len(a.images) <= 1:
        raise HTTPException(status_code=400, detail="至少需保留 1 张真实照片")

    # 物理文件删除（失败不影响数据库记录删除）
    try:
        full = os.path.join(UPLOAD_DIR, os.path.basename(img.filename))
        if os.path.exists(full):
            os.remove(full)
    except Exception:
        pass

    was_cover = img.is_cover
    db.delete(img)
    db.flush()
    if was_cover:
        first = db.query(AssetImage).filter(AssetImage.asset_id == a.id).order_by(AssetImage.id).first()
        if first:
            first.is_cover = True
    db.commit()
    db.refresh(a)
    return asset_dict(db, a)


# --------------------------- 管理员：物资管理 ---------------------------

@router.get("/api/admin/assets")
def admin_list_assets(
    keyword: str = "",
    status: str = "",
    college_id: Optional[int] = None,
    department_id: Optional[int] = None,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """全量物资（含下架/停用），驳回图片也一并展示以便核验"""
    q = db.query(Asset)
    if keyword.strip():
        kw = f"%{keyword.strip()}%"
        q = q.filter(or_(Asset.name.like(kw), Asset.asset_no.like(kw)))
    if status.strip():
        q = q.filter(Asset.status == status.strip())
    if college_id:
        q = q.filter(Asset.college_id == college_id)
    if department_id:
        q = q.filter(Asset.department_id == department_id)
    assets = q.order_by(Asset.publish_time.desc(), Asset.id.desc()).all()
    # include_rejected=True：管理员需要看到被驳回的图片以便核验
    return [asset_dict(db, a, include_rejected=True) for a in assets]


@router.put("/api/admin/assets/{asset_id}")
def admin_update_asset(
    asset_id: int,
    payload: AdminAssetUpdate,
    request: Request,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """
    管理员修正异常物资：可调整资产编号（校验唯一）、数量、各业务字段与状态。
    每次修正都留痕，记录改了哪些字段（旧值 -> 新值）。
    """
    a = _get_asset_or_404(db, asset_id)

    new_no = payload.asset_no.strip() if payload.asset_no is not None else None
    if new_no and new_no != a.asset_no:
        if not new_no:
            raise HTTPException(status_code=400, detail="资产编号不能为空")
        dup = db.query(Asset).filter(Asset.asset_no == new_no, Asset.id != a.id).first()
        if dup:
            raise HTTPException(status_code=400, detail=f"资产编号 {new_no} 已存在，平台内编号必须唯一")

    if payload.total_count is not None and payload.total_count <= 0:
        raise HTTPException(status_code=400, detail="总数必须为大于 0 的正整数")
    if payload.claimed_count is not None and payload.claimed_count < 0:
        raise HTTPException(status_code=400, detail="已认领数量不能为负")
    if payload.contact_phone is not None and payload.contact_phone.strip():
        if not PHONE_RE.fullmatch(payload.contact_phone.strip()):
            raise HTTPException(status_code=400, detail="联系电话格式不正确（手机号或固话如 010-12345678）")
    if payload.status is not None and payload.status not in ("on", "off", "disabled"):
        raise HTTPException(status_code=400, detail="状态仅支持 on 上架 / off 下架 / disabled 停用")

    # 逐字段比对并记录变更
    fields = [
        ("asset_no", "资产编号"), ("name", "资产名称"), ("category", "分类"),
        ("unit", "计量单位"), ("spec", "尺寸规格"), ("total_count", "总数"),
        ("claimed_count", "已认领"), ("condition_desc", "成色/状态说明"), ("remark", "备注"),
        ("using_person", "使用人"), ("usage_direction", "使用方向"), ("manage_dept", "使用的管理部门"),
        ("location", "存放地点"), ("contact_person", "联系人"), ("contact_emp_no", "联系人工号"),
        ("contact_phone", "联系电话"), ("status", "状态"),
    ]
    changes = []
    for key, label in fields:
        val = getattr(payload, key, None)
        if val is None:
            continue
        if isinstance(val, str):
            val = val.strip()
        old = getattr(a, key)
        if str(old) == str(val):
            continue
        changes.append(f"{label}：{old} -> {val}")
        setattr(a, key, val)

    if not changes:
        return asset_dict(db, a, include_rejected=True)

    # 数量规则：总数 − 已认领 = 剩余；剩余 = 0 自动下架；不允许为负
    if a.total_count < a.claimed_count:
        raise HTTPException(
            status_code=400,
            detail=f"总数不能小于已认领数量（已认领 {a.claimed_count}）",
        )
    a.remaining_count = a.total_count - a.claimed_count
    if a.remaining_count == 0 and a.status == "on":
        a.status = "off"
        changes.append("状态：on -> off（剩余归零自动下架）")

    reason = (payload.reason or "").strip()
    write_log(
        db,
        "update",
        admin,
        f"管理员修正物资：{a.name}（编号 {a.asset_no}）；" + "；".join(changes)
        + (f"；修正原因：{reason}" if reason else ""),
        asset_no=a.asset_no,
        request=request,
    )
    db.commit()
    return asset_dict(db, a, include_rejected=True)


@router.post("/api/admin/assets/{asset_id}/force-off")
def admin_force_off(
    asset_id: int,
    reason: str = "",
    request: Request = None,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """管理员强制下架（如发现虚假图片或违规发布），reason 通过 query 传入"""
    a = _get_asset_or_404(db, asset_id)
    reason = (reason or "").strip()
    a.status = "off"
    write_log(
        db,
        "off",
        admin,
        f"强制下架物资：{a.name}（编号 {a.asset_no}）{('，原因：' + reason) if reason else ''}",
        asset_no=a.asset_no,
        request=request,
    )
    db.commit()
    return asset_dict(db, a, include_rejected=True)


@router.post("/api/admin/assets/{asset_id}/relist")
def admin_relist(
    asset_id: int,
    request: Request,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """管理员重新挂牌：停用部门的物资可重新挂回平台供其他部门认领"""
    a = _get_asset_or_404(db, asset_id)
    if a.remaining_count <= 0:
        raise HTTPException(status_code=400, detail="剩余数量为 0，无法重新挂牌")
    a.status = "on"
    write_log(db, "relist", admin, f"重新挂牌物资：{a.name}（编号 {a.asset_no}）", asset_no=a.asset_no, request=request)
    db.commit()
    return asset_dict(db, a, include_rejected=True)


@router.post("/api/admin/assets/{asset_id}/images/{image_id}/reject")
def admin_reject_image(
    asset_id: int,
    image_id: int,
    payload: ImageRejectIn,
    request: Request,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """管理员驳回图片：AI生成/伪造/网图/与实物不符，要求发布部门重传真实照片"""
    a = _get_asset_or_404(db, asset_id)
    img = db.query(AssetImage).filter(AssetImage.id == image_id, AssetImage.asset_id == a.id).first()
    if img is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    img.audit_status = "rejected"
    img.reject_reason = payload.reason.strip() or "图片不真实"
    # 若被驳回的是首图，自动把首图顺延到下一张未驳回图片
    if img.is_cover:
        img.is_cover = False
        nxt = (
            db.query(AssetImage)
            .filter(AssetImage.asset_id == a.id, AssetImage.id != img.id, AssetImage.audit_status != "rejected")
            .order_by(AssetImage.id)
            .first()
        )
        if nxt:
            nxt.is_cover = True
    write_log(
        db,
        "image_reject",
        admin,
        f"驳回物资[{a.asset_no}]图片 #{img.id}：{img.reject_reason}",
        asset_no=a.asset_no,
        request=request,
    )
    db.commit()
    return asset_dict(db, a, include_rejected=True)


@router.post("/api/admin/assets/{asset_id}/images/{image_id}/restore")
def admin_restore_image(
    asset_id: int,
    image_id: int,
    request: Request,
    db: Session = Depends(get_db),
    admin=Depends(require_admin),
):
    """管理员撤销驳回（图片复核通过）"""
    a = _get_asset_or_404(db, asset_id)
    img = db.query(AssetImage).filter(AssetImage.id == image_id, AssetImage.asset_id == a.id).first()
    if img is None:
        raise HTTPException(status_code=404, detail="图片不存在")
    img.audit_status = "normal"
    img.reject_reason = ""
    write_log(db, "image_upload", admin, f"复核通过物资[{a.asset_no}]图片 #{img.id}", asset_no=a.asset_no, request=request)
    db.commit()
    return asset_dict(db, a, include_rejected=True)
