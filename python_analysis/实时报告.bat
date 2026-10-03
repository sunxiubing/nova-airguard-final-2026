@echo off
chcp 65001 >nul
title AirGuard 实时报告（监视中，关掉窗口即停止）
cd /d "%~dp0"

rem 优先用项目自带的虚拟环境（依赖齐全），找不到再退回系统 PATH 里的 python
if exist "%~dp0..\venv\Scripts\python.exe" (
    "%~dp0..\venv\Scripts\python.exe" "%~dp0serve.py"
) else if exist "%~dp0venv\Scripts\python.exe" (
    "%~dp0venv\Scripts\python.exe" "%~dp0serve.py"
) else (
    python "%~dp0serve.py"
)

rem 出错时停住，让双击的人来得及看清报错
if errorlevel 1 pause
