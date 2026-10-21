@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装 Node.js 20 或更高版本：https://nodejs.org/
  pause
  exit /b 1
)
if not exist node_modules (
  echo 首次运行，正在安装依赖……
  call npm install --no-fund --no-audit
  if errorlevel 1 (
    echo 安装依赖失败，请检查网络后重试
    pause
    exit /b 1
  )
)
node src\cli.js %*
pause
