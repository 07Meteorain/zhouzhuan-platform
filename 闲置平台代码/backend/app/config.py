# -*- coding: utf-8 -*-
"""
全局配置模块
------------------------------------------------------------------
负责读取环境变量（见仓库根目录 .env.example），所有路径/密钥均显式声明，
不依赖任何隐藏配置。所有目录在导入时自动创建，保证首次启动即可用。
"""
import os
from pathlib import Path

# backend/app/config.py -> parents[0]=app  parents[1]=backend  parents[2]=仓库根
BACKEND_DIR = Path(__file__).resolve().parents[1]
PROJECT_ROOT = Path(__file__).resolve().parents[2]


def _load_dotenv() -> None:
    """
    轻量加载仓库根目录的 .env（不引入 python-dotenv 依赖）。
    优先级：真实环境变量 > .env 中的值 > 代码默认值。
    Docker 场景由 compose 注入环境变量，本地直跑则读 .env。
    """
    env_file = PROJECT_ROOT / ".env"
    if not env_file.exists():
        return
    try:
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, v = line.split("=", 1)
            k, v = k.strip(), v.strip().strip('"').strip("'")
            if k and k not in os.environ:
                os.environ[k] = v
    except Exception:
        pass  # .env 解析失败不影响启动，回退到默认值


_load_dotenv()


def _resolve(p: str) -> str:
    """相对路径按仓库根目录解析，绝对路径原样返回"""
    path = Path(p)
    return str(path if path.is_absolute() else (PROJECT_ROOT / path))


# 数据库：SQLite 单文件。默认落在仓库内 database/data，保证免 Docker 直接可跑；
# 容器场景由 docker-compose.yml 注入 /app/data（挂载卷持久化）。
DATABASE_PATH = _resolve(os.getenv("DATABASE_PATH", "database/data/app.db"))

# 图片本地存储目录（水印图与元数据都放这里）
UPLOAD_DIR = _resolve(os.getenv("UPLOAD_DIR", "database/data/uploads"))

# 种子脚本与种子图片目录（首次启动自动建表并注入种子数据）
SEED_SCRIPT = _resolve(os.getenv("SEED_SCRIPT", "database/seed.py"))
SEED_IMAGE_DIR = _resolve(os.getenv("SEED_IMAGE_DIR", "database/seed_images"))

# JWT / Session 密钥与安全配置
SECRET_KEY = os.getenv("SECRET_KEY", "public-asset-idle-platform-dev-secret")
JWT_ALGORITHM = os.getenv("JWT_ALGORITHM", "HS256")
# 登录有效期（小时）
JWT_EXPIRE_HOURS = int(os.getenv("JWT_EXPIRE_HOURS", "12"))

# 允许的跨域来源（前端由 nginx 同源反代，一般无需配置）
CORS_ORIGINS = [
    o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()
]

# 上传图片限制
MAX_IMAGE_BYTES = int(os.getenv("MAX_IMAGE_BYTES", str(10 * 1024 * 1024)))  # 单张最大 10MB
MAX_IMAGE_COUNT = int(os.getenv("MAX_IMAGE_COUNT", "9"))                     # 单次最多 9 张
ALLOWED_IMAGE_EXT = {".jpg", ".jpeg", ".png", ".webp", ".bmp", ".gif"}


def ensure_dirs() -> None:
    """确保数据库文件所在目录与上传目录存在"""
    Path(DATABASE_PATH).parent.mkdir(parents=True, exist_ok=True)
    Path(UPLOAD_DIR).mkdir(parents=True, exist_ok=True)
