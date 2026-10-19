@echo off
chcp 65001 >nul
setlocal EnableDelayedExpansion
cd /d "%~dp0"

echo ==========================================================
echo   公共资产闲置平台 —— 一键启动（免 Docker）
echo   后端 http://127.0.0.1:8000     前端 http://127.0.0.1:3000
echo ==========================================================
echo.

rem ---------- 0. 定位 Python ----------
set "PYEXE="
for %%P in (python py python3) do (
    if not defined PYEXE (
        %%P -c "import sys; sys.exit(0 if sys.version_info>=(3,10) else 1)" >nul 2>&1
        if !errorlevel! == 0 (
            for /f "delims=" %%F in ('%%P -c "import sys;print(sys.executable)"') do set "PYEXE=%%F"
        )
    )
)
if not defined PYEXE (
    echo [错误] 未找到 Python 3.10 及以上版本。
    echo        请先安装 Python 并在安装时勾选 "Add python.exe to PATH"。
    pause
    exit /b 1
)
echo [0/4] 使用 Python: %PYEXE%

rem ---------- 1. 虚拟环境 ----------
if not exist ".venv\Scripts\python.exe" (
    echo [1/4] 首次启动：创建虚拟环境 .venv ...
    "%PYEXE%" -m venv .venv
    if errorlevel 1 (
        echo [错误] 虚拟环境创建失败，请确认 Python 安装完整（含 venv 模块）。
        pause
        exit /b 1
    )
) else (
    echo [1/4] 虚拟环境已存在，跳过创建
)
set "VPY=%CD%\.venv\Scripts\python.exe"

rem ---------- 2. 安装依赖 ----------
echo [2/4] 安装 / 校验后端依赖（首次较慢）...
"%VPY%" -m pip install -q --disable-pip-version-check -r backend\requirements.txt
if errorlevel 1 (
    echo [提示] 默认源安装失败，尝试清华镜像源 ...
    "%VPY%" -m pip install -q --disable-pip-version-check -r backend\requirements.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
    if errorlevel 1 (
        echo [错误] 依赖安装失败，请检查网络或手动执行：
        echo        .venv\Scripts\python.exe -m pip install -r backend\requirements.txt
        pause
        exit /b 1
    )
)

rem ---------- 3. 配置文件 ----------
if not exist ".env" (
    echo [3/4] 生成 .env（从 .env.example 复制）...
    copy /y .env.example .env >nul
) else (
    echo [3/4] .env 已存在，跳过生成
)

rem ---------- 4. 启动服务 ----------
echo [4/4] 启动后端与前端 ...
if not exist "database\data" mkdir "database\data"
if not exist "logs" mkdir "logs"

start "PAIP-后端 8000" /min cmd /c "cd /d "%~dp0backend" && "%VPY%" -m uvicorn app.main:app --host 127.0.0.1 --port 8000 > "%~dp0logs\backend.log" 2>&1"
start "PAIP-前端 3000" /min cmd /c "cd /d "%~dp0" && "%VPY%" tools\dev_server.py --port 3000 --backend http://127.0.0.1:8000 > "%~dp0logs\frontend.log" 2>&1"

echo.
echo 正在等待服务就绪 ...
set /a WAIT=0
:WAIT_LOOP
set /a WAIT+=1
timeout /t 2 >nul
"%VPY%" -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/api/health',timeout=2).status==200 else 1)" >nul 2>&1
if !errorlevel! == 0 goto READY
if !WAIT! GEQ 20 goto TIMEOUT
goto WAIT_LOOP

:READY
echo.
echo   启动成功！
echo   前端入口： http://127.0.0.1:3000
echo   接口文档： http://127.0.0.1:8000/docs
echo   测试账号： user1 / 123456（部门用户）   admin1 / 123456（管理员）
echo.
echo   关闭服务请运行 stop.bat
start "" http://127.0.0.1:3000
pause
exit /b 0

:TIMEOUT
echo.
echo [警告] 20 秒内后端未就绪，请查看 logs\backend.log 排查。
echo        常见原因：8000 端口被占用（可改 start.bat 里的端口）。
pause
exit /b 1
