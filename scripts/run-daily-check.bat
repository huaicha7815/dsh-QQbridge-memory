@echo off
rem 每日自检的包装脚本：给 Windows 计划任务用。
rem
rem 为什么不直接把 node 写进 schtasks：计划任务不设工作目录，
rem 直接跑 node scripts\test-daily.mjs 会找不到相对路径（找不到 scripts/、config.json）。
rem 这里先 cd 到仓库根，再跑；退出码原样传给计划任务（0=全过，1=有失败）。
chcp 65001 >nul
cd /d "%~dp0.."
node scripts\test-daily.mjs --quiet
exit /b %errorlevel%
