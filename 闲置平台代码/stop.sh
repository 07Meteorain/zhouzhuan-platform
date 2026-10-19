#!/usr/bin/env bash
# ==========================================================
#   公共资产闲置平台 —— 停止服务（免 Docker）
# ==========================================================
cd "$(dirname "$0")"

echo "=========================================================="
echo "  公共资产闲置平台 —— 停止服务"
echo "=========================================================="

STOPPED=0
for pidfile in logs/backend.pid logs/frontend.pid; do
    if [ -f "$pidfile" ]; then
        PID=$(cat "$pidfile")
        if kill -0 "$PID" 2>/dev/null; then
            echo "  停止进程 PID=$PID（来自 $pidfile）"
            kill "$PID" 2>/dev/null || true
            STOPPED=1
        fi
        rm -f "$pidfile"
    fi
done

# 兜底：按端口再清理一次（防止 pid 文件丢失导致残留）
for PORT in 8000 3000; do
    PIDS=$(lsof -ti tcp:"$PORT" 2>/dev/null || true)
    if [ -n "$PIDS" ]; then
        echo "  清理端口 $PORT 上的残留进程：$PIDS"
        kill -9 $PIDS 2>/dev/null || true
        STOPPED=1
    fi
done

if [ "$STOPPED" = "0" ]; then
    echo "  未发现运行中的服务"
else
    echo "  已停止"
fi
echo ""
echo "  重新启动请运行 ./start.sh"
