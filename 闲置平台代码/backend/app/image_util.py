# -*- coding: utf-8 -*-
"""
图片处理与真实性校验模块
------------------------------------------------------------------
规则（见产品说明书第 5 节）：
  允许：现场拍照上传、手机/设备相册上传的真实物资照片
  禁止：AI 生成图、合成拼接伪造图、网图盗图、与实物不符的说明图

落地实现（工程上可做到的强校验 + 人工兜底）：
  1. 文件头魔数校验：必须是真实 JPEG/PNG/WebP/BMP/GIF 二进制，拒绝伪装扩展名
  2. 可被 Pillow 正常解码：拒绝损坏文件
  3. 内容指纹 sha256：与平台已有图片比对，重复图（盗图/网图常见特征）直接拒绝
  4. 最小像素与最小体积：过小、过度压缩的图（多为网图搬运）拒绝
  5. 自动水印：在图上叠加“部门 + 资产编号 + 拍摄/上传时间”，留痕可追溯
  6. 管理员抽检驳回：/api/admin/assets/{id}/images/{image_id}/reject
"""
import hashlib
import io
import os
import secrets
from datetime import datetime

from PIL import Image, ImageDraw, ImageFont

from .config import ALLOWED_IMAGE_EXT, MAX_IMAGE_BYTES, UPLOAD_DIR

# 常见图片格式的二进制魔数
_MAGIC = [
    (b"\xff\xd8\xff", "jpg"),   # JPEG
    (b"\x89PNG\r\n\x1a\n", "png"),  # PNG
    (b"RIFF", "webp"),          # WEBP（RIFF....WEBP）
    (b"BM", "bmp"),             # BMP
    (b"GIF87a", "gif"),         # GIF
    (b"GIF89a", "gif"),         # GIF
]

MIN_PIXELS = 200        # 最小边长，低于此视为可疑缩略图
MIN_FILE_SIZE = 5 * 1024  # 5KB 以下多为搬运的压缩图


class ImageRejected(Exception):
    """图片未通过真实性校验，抛出后由路由转成 400 返回给前端"""


def _detect_ext(data: bytes, filename: str) -> str:
    """通过魔数判断真实格式，拒绝扩展名伪装"""
    head = data[:16]
    for magic, ext in _MAGIC:
        if head.startswith(magic):
            if ext == "webp" and head[8:12] != b"WEBP":
                continue
            return ext
    raise ImageRejected("文件不是有效的图片（文件头校验失败），请现场拍照或选择相册中的真实照片上传")


def validate_image(data: bytes, filename: str, db, AssetImage) -> tuple[bytes, int, int, str]:
    """
    校验图片真实性。
    返回 (watermarked_bytes, width, height, sha256_hex)
    """
    ext = os.path.splitext(filename or "")[1].lower()
    if ext not in ALLOWED_IMAGE_EXT:
        raise ImageRejected(f"不支持的图片格式 {ext or '(无扩展名)'}，仅支持 jpg/png/webp/bmp/gif")

    if len(data) > MAX_IMAGE_BYTES:
        raise ImageRejected(f"单张图片超过 {MAX_IMAGE_BYTES // 1024 // 1024}MB 限制")

    _detect_ext(data, filename)

    try:
        img = Image.open(io.BytesIO(data))
        img.load()
    except Exception:
        raise ImageRejected("图片无法解析或已损坏，请重新拍摄上传")

    width, height = img.size
    if width < MIN_PIXELS or height < MIN_PIXELS:
        raise ImageRejected(f"图片分辨率过小（{width}x{height}），请上传清晰的实物照片")

    if len(data) < MIN_FILE_SIZE:
        raise ImageRejected("图片文件过小，疑似网络下载图，请现场拍摄上传")

    sha = hashlib.sha256(data).hexdigest()
    # 指纹查重：平台内已存在完全相同内容的图片，判定为盗图/重复上传
    dup = db.query(AssetImage).filter(AssetImage.sha256 == sha).first()
    if dup is not None:
        raise ImageRejected("该图片已存在于平台（内容重复），疑似盗用他人图片，请重新拍摄")

    return img, width, height, sha


def make_watermark(img: Image.Image, text: str) -> Image.Image:
    """在图片右下角叠加半透明水印文字，返回新的 PIL Image"""
    base = img.convert("RGB")
    draw = ImageDraw.Draw(base)
    font = None
    # 依次尝试常见字体路径，兼容 Windows / Linux / 容器环境
    candidates = [
        "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/simhei.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    ]
    for path in candidates:
        try:
            if os.path.exists(path):
                font = ImageFont.truetype(path, max(16, base.width // 30))
                break
        except Exception:
            continue
    if font is None:
        font = ImageFont.load_default()

    # Pillow >= 8 支持 textbbox
    try:
        bbox = draw.textbbox((0, 0), text, font=font)
        tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    except AttributeError:  # 兼容老版本
        tw, th = draw.textsize(text, font=font)

    padding = 10
    x = base.width - tw - padding
    y = base.height - th - padding
    x = max(padding, x)
    y = max(padding, y)

    # 先画深色描边保证在任何背景上都可读
    for dx, dy in ((1, 1), (-1, 1), (1, -1), (-1, -1)):
        draw.text((x + dx, y + dy), text, font=font, fill=(0, 0, 0))
    draw.text((x, y), text, font=font, fill=(255, 255, 255))
    return base


def save_image(data: bytes, filename: str, db, AssetImage, watermark_text: str = "") -> dict:
    """
    校验 -> 加水印 -> 落盘到 UPLOAD_DIR。
    返回图片元信息字典（不含 ORM 对象）。
    """
    img, width, height, sha = validate_image(data, filename, db, AssetImage)

    ext = os.path.splitext(filename or "")[1].lower() or ".jpg"
    if ext == ".jpeg":
        ext = ".jpg"
    ts = datetime.now().strftime("%Y%m%d%H%M%S")
    new_name = f"{ts}_{secrets.token_hex(6)}{ext}"

    os.makedirs(UPLOAD_DIR, exist_ok=True)
    target = os.path.join(UPLOAD_DIR, new_name)

    if watermark_text:
        wm_img = make_watermark(img, watermark_text)
        wm_img.save(target, quality=88)
    else:
        with open(target, "wb") as f:
            f.write(data)

    return {
        "filename": new_name,
        "origin_filename": filename or "",
        "url": f"/uploads/{new_name}",
        "width": width,
        "height": height,
        "sha256": sha,
        "file_size": os.path.getsize(target),
        "watermark": watermark_text,
    }
