# -*- coding: utf-8 -*-
"""
请求/响应数据结构（Pydantic v2）
------------------------------------------------------------------
仅用于校验入参与规范化出参；物资发布因含多图上传改用 multipart Form，
字段定义见 routers/assets.py 顶部注释。
"""
from typing import Optional

from pydantic import BaseModel, Field


# ------------------------------ 认证 ------------------------------

class LoginIn(BaseModel):
    username: str = Field(..., description="登录账号")
    password: str = Field(..., description="登录口令")


class UserOut(BaseModel):
    id: int
    username: str
    name: str
    employee_no: str
    phone: str
    role: str
    college_id: Optional[int] = None
    department_id: Optional[int] = None
    college_name: str = ""
    department_name: str = ""
    dept_full_name: str = ""
    status: str


# ---------------------------- 组织机构 ----------------------------

class CollegeIn(BaseModel):
    name: str
    code: str = ""


class CollegeUpdate(BaseModel):
    name: Optional[str] = None
    code: Optional[str] = None
    status: Optional[str] = None


class DepartmentIn(BaseModel):
    college_id: int
    name: str
    code: str = ""


class DepartmentUpdate(BaseModel):
    college_id: Optional[int] = None
    name: Optional[str] = None
    code: Optional[str] = None
    status: Optional[str] = None


# ------------------------------ 用户 ------------------------------

class UserCreate(BaseModel):
    username: str
    password: str
    name: str
    employee_no: str
    phone: str = ""
    role: str = "user"
    college_id: Optional[int] = None
    department_id: Optional[int] = None


class UserUpdate(BaseModel):
    name: Optional[str] = None
    employee_no: Optional[str] = None
    phone: Optional[str] = None
    password: Optional[str] = None
    role: Optional[str] = None
    college_id: Optional[int] = None
    department_id: Optional[int] = None
    status: Optional[str] = None


# ------------------------------ 物资 ------------------------------

class AssetUpdate(BaseModel):
    name: Optional[str] = None
    category: Optional[str] = None
    unit: Optional[str] = None
    spec: Optional[str] = None
    total_count: Optional[int] = None
    condition_desc: Optional[str] = None
    remark: Optional[str] = None
    using_person: Optional[str] = None
    usage_direction: Optional[str] = None
    manage_dept: Optional[str] = None
    location: Optional[str] = None
    contact_person: Optional[str] = None
    contact_emp_no: Optional[str] = None
    contact_phone: Optional[str] = None


class ClaimIn(BaseModel):
    asset_id: int
    quantity: int
    receiver_name: str
    receiver_emp_no: str
    receiver_phone: str = ""
    remark: str = ""
    # 接收（转入）部门：留空则默认认领人所属部门；也可指定其他部门代收
    receiver_college_id: Optional[int] = None
    receiver_department_id: Optional[int] = None


class AdminAssetUpdate(BaseModel):
    """管理员修正异常物资：所有业务字段均可调整（资产编号变更需校验唯一性）"""

    asset_no: Optional[str] = None
    name: Optional[str] = None
    category: Optional[str] = None
    unit: Optional[str] = None
    spec: Optional[str] = None
    total_count: Optional[int] = None
    claimed_count: Optional[int] = None
    condition_desc: Optional[str] = None
    remark: Optional[str] = None
    using_person: Optional[str] = None
    usage_direction: Optional[str] = None
    manage_dept: Optional[str] = None
    location: Optional[str] = None
    contact_person: Optional[str] = None
    contact_emp_no: Optional[str] = None
    contact_phone: Optional[str] = None
    status: Optional[str] = None
    # 修正原因，写入日志
    reason: str = ""


class HandoverIn(BaseModel):
    claim_id: int


class ImageRejectIn(BaseModel):
    reason: str = "图片疑似AI生成/伪造/与实物不符，请重新拍摄上传"


class ImageCaptionIn(BaseModel):
    caption: str = ""


class AssetActionIn(BaseModel):
    reason: str = ""
