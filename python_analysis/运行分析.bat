@echo off
chcp 65001 >nul
title AirGuard 离线分析链 A
cd /d "%~dp0"

rem 优先用项目自带的虚拟环境（依赖齐全），找不到再退回系统 PATH 里的 python
if exist "%~dp0..\venv\Scripts\python.exe" (
    "%~dp0..\venv\Scripts\python.exe" "%~dp0analysis.py"
) else if exist "%~dp0venv\Scripts\python.exe" (
    "%~dp0venv\Scripts\python.exe" "%~dp0analysis.py"
) else (
    python "%~dp0analysis.py"
)

rem 出错时停住，让双击的人来得及看清报错
if errorlevel 1 pause
