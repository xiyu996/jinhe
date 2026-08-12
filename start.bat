@echo off
echo ============================================
echo   锦和出行 · 活动安排协作服务器
echo ============================================
echo.
cd /d "%~dp0"
echo [1/2] 检查依赖...
if not exist "node_modules" (
    echo 正在安装依赖...
    call npm install
)
echo [2/2] 启动服务器...
echo.
node server.js
pause
