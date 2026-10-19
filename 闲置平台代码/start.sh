#!/usr/bin/env bash
# ==========================================================
#   公共资产闲置平台 —— 一键启动（免 Docker）
#   Linux / macOS / Git Bash 通用
#   后端 http://127.0.0.1:8000    前端 http://127.0.0.1:3000
# ==========================================================
set -e
cd "$(dirname "$0")"

echo "=========================================================="
echo "  公共资产闲置平台 —— 一键启动（免 Docker）"
echo "=========================================================="

# ---------- 0. 定位 Python ----------
PY=""
for cand in python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then
        if "$cand" -c 'import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)' 2>/dev/null; then
            PY="$cand"
            break
        fi
    fi
done
if [ -z "$PY" ]; then
    echo "[错误] 未找到 Python 3.10 及以上版本，请先安装 Python 3.10+"
    exit 1
fi
echo "[0/4] 使用 Python: $($PY -c 'import sys;print(sys.executable)')"

# ---------- 1. 虚拟环境 ----------
if [ ! -x ".venv/bin/python" ]; then
    echo "[1/4] 首次启动：创建虚拟环境 .venv ..."
    "$PY" -m venv .venv
else
    echo "[1/4] 虚拟环境已存在，跳过创建"
fi
VPY=".venv/bin/python"

# ---------- 2. 安装依赖 ----------
echo "[2/4] 安装 / 校验后端依赖（首次较慢）..."
if ! "$VPY" -m pip install -q --disable-pip-version-check -r backend/requirements.txt; then
    echo "[提示] 默认源安装失败，尝试清华镜像源 ..."
    "$VPY" -m pip install -q --disable-pip-version-check -r backend/requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
fi

# ---------- 3. 配置文件 ----------
if [ ! -f ".env" ]; then
    echo "[3/4] 生成 .env（从 .env.example 复制）..."
    cp .env.example .env
else
    echo "[3/4] .env 已存在，跳过生成"
fi

# ---------- 4. 启动服务 ----------
echo "[4/4] 启动后端与前端 ..."
mkdir -p database/data logs

( cd backend && nohup "$VPY" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 > ../logs/backend.log 2>&1 & echo $! > ../logs/backend.pid )
nohup "$VPY" tools/dev_server.py --port 3000 --backend http://127.0.0.1:8000 > logs/frontend.log 2>&1 &
echo $! > logs/frontend.pid

echo "正在等待服务就绪 ..."
for i in $(seq 1 30); do
    if "$VPY" -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=2).status==200 else 1)" 2>/dev/null; then
        echo ""
        echo "  启动成功！"
        echo "  前端入口： http://127.0.0.1:3000"
        echo "  接口文档： http://127.0.0.1:8000/docs"
        echo "  测试账号： user1 / 123456（部门用户）   admin1 / 123456（管理员）"
        echo ""
        echo "  关闭服务请运行 ./stop.sh"
        exit 0
    fi
    sleep 1
done

echo "[警告] 30 秒内后端未就绪，请查看 logs/backend.log 排查。"
exit 1
