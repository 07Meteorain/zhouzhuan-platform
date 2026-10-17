@echo off
chcp 65001 >nul
REM 停止周转物资平台服务
cd /d "%~dp0"

for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000.*LISTENING"') do (
  echo 正在停止 PID %%p ...
  taskkill /F /PID %%p >nul 2>nul
)

echo.
echo 服务已停止。
pause