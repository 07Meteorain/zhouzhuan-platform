@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ==========================================================
echo   公共资产闲置平台 —— 停止服务
echo ==========================================================

rem ---------- 释放 8000（后端）与 3000（前端）端口 ----------
set "FOUND=0"
for %%P in (8000 3000) do (
    for /f "tokens=5" %%I in ('netstat -ano ^| findstr ":%%P " ^| findstr LISTENING') do (
        set "PID=%%I"
        if defined PID (
            echo   停止端口 %%P 上的进程 PID=!PID!
            taskkill /PID !PID! /F >nul 2>&1
            set "FOUND=1"
        )
    )
)

if "!FOUND!" == "0" (
    echo   未发现运行中的服务（8000 / 3000 端口空闲）
) else (
    echo   已停止
)

echo.
echo   重新启动请运行 start.bat
pause
exit /b 0
