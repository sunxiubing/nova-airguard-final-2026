@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

set "PY="
if exist "..\venv\Scripts\python.exe" set "PY=..\venv\Scripts\python.exe"
if not defined PY if exist "..\..\venv\Scripts\python.exe" set "PY=..\..\venv\Scripts\python.exe"
if not defined PY set "PY=python"

echo.
echo   AirGuard D5 · 发送演示报文（规则判正常 / ML 判偏离历史）
echo   目标 Broker: broker.emqx.io:1883（公网）
echo.
echo   * 先确保 实时报告.bat 已经在运行，报告页会自己刷新出这一条。
echo   * 只发一条，发送后本窗口停在结果上，按任意键关闭。
echo.

"%PY%" d5_publish.py %*

echo.
pause
