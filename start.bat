@echo off
chcp 65001 >nul
REM 周转物资平台启动器 —— 双击即可运行，窗口关闭不影响服务
cd /d "%~dp0"

REM 检查 Node.js 是否可用
where node >nul 2>nul
if errorlevel 1 (
  echo [错误] 未找到 Node.js，请先安装 Node.js 18 及以上版本
  pause
  exit /b 1
)

REM 端口 3000 已被占用则直接提示，不再重复启动
netstat -ano | findstr ":3000.*LISTENING" >nul
if not errorlevel 1 (
  echo [提示] 端口 3000 已在监听，服务可能已在运行
  echo 请直接访问 http://localhost:3000
  pause
  exit /b 0
)

echo 正在启动周转物资平台...
start "周转物资平台" /min node server\index.js
timeout /t 3 /nobreak >nul
echo.
echo 服务已启动，请访问 http://localhost:3000
echo 关闭本窗口不会停止服务；如需停止请运行 stop.bat
pause