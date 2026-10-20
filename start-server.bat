@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ==========================================
echo   照片水印 - 本地预览服务器
echo ==========================================
echo.
echo 浏览器必须通过 http 访问，直接双击 index.html
echo 会导致 Service Worker（离线缓存）不工作。
echo.
where python >nul 2>nul
if errorlevel 1 goto try_node
echo 正在启动: http://127.0.0.1:8000
echo 按 Ctrl+C 停止服务器
echo.
start "" http://127.0.0.1:8000
python -m http.server 8000 --bind 127.0.0.1
goto end

:try_node
where node >nul 2>nul
if errorlevel 1 goto no_runtime
echo 未找到 Python，改用 Node 启动...
echo 正在启动: http://127.0.0.1:8000
echo 按 Ctrl+C 停止服务器
echo.
start "" http://127.0.0.1:8000
npx --yes serve . -l 8000
goto end

:no_runtime
echo 未找到 Python 或 Node。
echo 请任选一种方式：
echo   1. 安装 Python 后重新运行本脚本
echo   2. 用 VS Code 的 Live Server 扩展打开本目录
echo   3. 部署到 GitHub Pages / Cloudflare Pages 后直接用网址访问
pause

:end
