@echo off
chcp 65001 >nul
title AirGuard 停止监视
cd /d "%~dp0"

rem 只停「本服务」：先问 /api/status，确认 service 字段是 airguard-serve 才动手，
rem 免得误杀碰巧占着 8787 的别的程序。后台方式（实时报告-后台.vbs）没有窗口可关，
rem 只能从这里停；窗口方式直接关窗口或按 Ctrl+C 也行。
rem 整个 PowerShell 写在一行里——batch 的 ^ 续行在引号中间不可靠。

powershell -NoProfile -ExecutionPolicy Bypass -Command "$found=$false; foreach($p in 8787..8798){ try{ $s=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$p+'/api/status') -TimeoutSec 1; if($s.service -eq 'airguard-serve'){ Stop-Process -Id $s.pid -Force; Write-Host ('已停止 AirGuard 监视服务（PID '+$s.pid+' · 端口 '+$p+'）'); $found=$true; break } }catch{} }; if(-not $found){ Write-Host '没有找到正在运行的 AirGuard 监视服务。' }"

echo.
pause
