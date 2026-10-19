# -*- coding: utf-8 -*-
"""
数据模型层（ORM）
------------------------------------------------------------------
共 8 张表：
  1. colleges    专业学院
  2. departments 学院下设部门
  3. users       用户（部门用户 / 平台管理员）
  4. assets      物资主数据
  5. asset_images 物资图片（多图 + 首图 + 真实性审核）
  6. claims      认领记录（= 流转记录）
  7. handovers   交接单
  8. logs        操作日志（不可删除）

每个字段均带中文注释；状态字段统一使用字符串枚举：
  - 机构/用户/图片：active | disabled、normal | rejected
  - 物资：on（上架）| off（下架）| disabled（停用）
"""
from datetime import datetime

from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import relationship

from .database import Base


def now() -> datetime:
    return datetime.now()


class College(Base):
    """专业学院（一级组织）"""

    __tablename__ = "colleges"

    id = Column(Integer, primary_key=True, index=True, comment="学院ID")
    name = Column(String(100), nullable=False, unique=True, comment="学院名称")
    code = Column(String(50), default="", comment="学院编码（可选）")
    status = Column(String(20), default="active", comment="状态：active启用 / disabled停用")
    created_at = Column(DateTime, default=now, comment="创建时间")

    departments = relationship(
        "Department", back_populates="college", cascade="all, delete-orphan"
    )


class Department(Base):
    """学院下设部门（二级组织）"""

    __tablename__ = "departments"

    id = Column(Integer, primary_key=True, index=True, comment="部门ID")
    college_id = Column(Integer, ForeignKey("colleges.id"), nullable=False, comment="所属学院ID")
    name = Column(String(100), nullable=False, comment="部门名称")
    code = Column(String(50), default="", comment="部门编码（可选）")
    status = Column(String(20), default="active", comment="状态：active启用 / disabled停用")
    created_at = Column(DateTime, default=now, comment="创建时间")

    college = relationship("College", back_populates="departments")


class User(Base):
    """系统用户：部门用户（user）/ 平台管理员（admin）"""

    __tablename__ = "users"

    id = Column(Integer, primary_key=True, index=True, comment="用户ID")
    username = Column(String(50), nullable=False, unique=True, index=True, comment="登录账号")
    password_hash = Column(String(128), nullable=False, comment="口令哈希（PBKDF2-SHA256）")
    salt = Column(String(32), nullable=False, comment="口令盐值")
    name = Column(String(50), default="", comment="姓名")
    employee_no = Column(String(50), default="", index=True, comment="工号")
    phone = Column(String(30), default="", comment="联系电话")
    role = Column(String(20), default="user", comment="角色：user部门用户 / admin管理员")
    college_id = Column(Integer, ForeignKey("colleges.id"), comment="所属学院ID")
    department_id = Column(Integer, ForeignKey("departments.id"), comment="所属下设部门ID")
    status = Column(String(20), default="active", comment="状态：active启用 / disabled停用")
    created_at = Column(DateTime, default=now, comment="创建时间")


class Asset(Base):
    """物资主数据（公共资产闲置平台共享池的核心对象）"""

    __tablename__ = "assets"
    __table_args__ = (UniqueConstraint("asset_no", name="uq_assets_asset_no"),)

    id = Column(Integer, primary_key=True, index=True, comment="物资ID")
    # —— 资产信息 ——
    asset_no = Column(String(64), nullable=False, unique=True, index=True, comment="资产编号（平台唯一）")
    name = Column(String(120), nullable=False, comment="资产名称")
    category = Column(String(60), default="", comment="分类")
    unit = Column(String(30), default="件", comment="计量单位")
    spec = Column(String(120), default="", comment="尺寸规格")
    total_count = Column(Integer, default=0, comment="总数（正整数）")
    claimed_count = Column(Integer, default=0, comment="已认领数量")
    remaining_count = Column(Integer, default=0, comment="剩余数量 = 总数 - 已认领")
    condition_desc = Column(String(200), default="", comment="成色/状态说明")
    remark = Column(Text, default="", comment="备注")

    # —— 使用管理 ——
    using_person = Column(String(60), default="", comment="使用人")
    usage_direction = Column(String(120), default="", comment="使用方向")
    manage_dept = Column(String(120), default="", comment="使用的管理部门")

    # —— 存放联系 ——
    location = Column(String(120), default="", comment="存放地点")
    contact_person = Column(String(60), default="", comment="联系人")
    contact_emp_no = Column(String(50), default="", comment="联系人工号")
    contact_phone = Column(String(30), default="", comment="联系电话")

    # —— 发布信息 ——
    college_id = Column(Integer, ForeignKey("colleges.id"), comment="发布学院ID")
    department_id = Column(Integer, ForeignKey("departments.id"), comment="发布下设部门ID")
    publisher_id = Column(Integer, ForeignKey("users.id"), comment="发布人ID")
    publisher_name = Column(String(60), default="", comment="发布人姓名")
    publisher_emp_no = Column(String(50), default="", comment="发布人工号")
    publish_time = Column(DateTime, default=now, comment="发布时间")
    # 状态：on 上架 / off 下架 / disabled 停用
    status = Column(String(20), default="on", comment="状态：on上架 / off下架 / disabled停用")
    updated_at = Column(DateTime, default=now, onupdate=now, comment="更新时间")

    images = relationship(
        "AssetImage", back_populates="asset", cascade="all, delete-orphan"
    )


class AssetImage(Base):
    """物资图片：多图上传、首图标记、真实性审核留痕"""

    __tablename__ = "asset_images"

    id = Column(Integer, primary_key=True, index=True, comment="图片ID")
    asset_id = Column(Integer, ForeignKey("assets.id"), nullable=False, comment="所属物资ID")
    filename = Column(String(200), nullable=False, comment="存储文件名（含水印图）")
    origin_filename = Column(String(200), default="", comment="原始文件名")
    url = Column(String(300), default="", comment="访问路径 /uploads/xxx")
    is_cover = Column(Boolean, default=False, comment="是否首图")
    caption = Column(String(200), default="", comment="图片说明")
    # 真实性留痕
    uploader_id = Column(Integer, comment="上传人ID")
    uploader_name = Column(String(60), default="", comment="上传人姓名")
    uploader_emp_no = Column(String(50), default="", comment="上传人工号")
    uploader_dept = Column(String(120), default="", comment="上传人所属部门")
    upload_time = Column(DateTime, default=now, comment="上传时间")
    file_size = Column(Integer, default=0, comment="文件字节数")
    width = Column(Integer, default=0, comment="图片宽度")
    height = Column(Integer, default=0, comment="图片高度")
    sha256 = Column(String(64), default="", index=True, comment="文件内容指纹（查重用）")
    watermark = Column(String(200), default="", comment="水印文字：部门+资产编号+时间")
    # 审核：normal 正常 / rejected 已驳回
    audit_status = Column(String(20), default="normal", comment="审核状态：normal正常 / rejected已驳回")
    reject_reason = Column(String(300), default="", comment="驳回原因")

    asset = relationship("Asset", back_populates="images")


class Claim(Base):
    """认领记录 = 流转记录：谁从哪个部门转到哪个部门、数量、时间"""

    __tablename__ = "claims"

    id = Column(Integer, primary_key=True, index=True, comment="认领记录ID")
    asset_id = Column(Integer, ForeignKey("assets.id"), nullable=False, comment="物资ID")
    asset_no = Column(String(64), default="", comment="资产编号（冗余，便于检索）")
    asset_name = Column(String(120), default="", comment="资产名称（冗余）")
    unit = Column(String(30), default="", comment="计量单位")
    quantity = Column(Integer, default=0, comment="本次认领数量")

    # 转出方
    from_college_id = Column(Integer, comment="转出学院ID")
    from_dept_id = Column(Integer, comment="转出部门ID")
    from_dept_name = Column(String(160), default="", comment="转出部门（学院+部门）")

    # 转入方
    to_college_id = Column(Integer, comment="转入学院ID")
    to_dept_id = Column(Integer, comment="转入部门ID")
    to_dept_name = Column(String(160), default="", comment="转入部门（学院+部门）")

    # 接收人
    receiver_name = Column(String(60), default="", comment="接收人姓名")
    receiver_emp_no = Column(String(50), default="", comment="接收人工号")
    receiver_phone = Column(String(30), default="", comment="接收人联系电话")

    claim_time = Column(DateTime, default=now, comment="认领时间")
    handover_no = Column(String(64), default="", index=True, comment="交接单号（生成交接单后回填）")
    remark = Column(Text, default="", comment="备注")
    claimer_id = Column(Integer, comment="认领操作人ID")
    # 状态：normal 正常 / revoked 已撤销（管理员操作）
    status = Column(String(20), default="normal", comment="状态：normal正常 / revoked已撤销")


class Handover(Base):
    """交接单：一次认领生成一张可打印的交接单"""

    __tablename__ = "handovers"

    id = Column(Integer, primary_key=True, index=True, comment="交接单ID")
    handover_no = Column(String(64), nullable=False, unique=True, index=True, comment="交接单号")
    claim_id = Column(Integer, ForeignKey("claims.id"), nullable=False, comment="关联认领记录ID")
    asset_id = Column(Integer, ForeignKey("assets.id"), comment="物资ID")
    generated_by = Column(Integer, comment="生成人ID")
    generated_by_name = Column(String(60), default="", comment="生成人姓名")
    generated_time = Column(DateTime, default=now, comment="生成时间")
    print_count = Column(Integer, default=0, comment="打印次数")


class Log(Base):
    """操作日志：不可删除，可查询导出"""

    __tablename__ = "logs"

    id = Column(Integer, primary_key=True, index=True, comment="日志ID")
    # 操作类型：publish / update / claim / off / relist / image_upload / image_reject
    #          / org_change / user_change / handover_gen / handover_print / login / claim_revoke
    type = Column(String(40), default="", index=True, comment="操作类型")
    operator_id = Column(Integer, comment="操作人ID")
    operator_name = Column(String(60), default="", comment="操作人姓名")
    emp_no = Column(String(50), default="", index=True, comment="工号")
    dept_name = Column(String(160), default="", comment="所属部门")
    asset_no = Column(String(64), default="", index=True, comment="资产编号")
    quantity = Column(Integer, comment="数量（无则为空）")
    time = Column(DateTime, default=now, index=True, comment="操作时间")
    detail = Column(Text, default="", comment="操作详情")
    ip = Column(String(64), default="", comment="IP/终端")
