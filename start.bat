@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Harden state/ ACLs (Windows needs WRITE_DAC; the directory owner normally has it,
rem so no UAC prompt in the usual case). This NEVER blocks startup: if it cannot get
rem permission it prints a copy-pasteable command and exits 0.
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
rem 启动大肥鱼本地 TTS 常驻服务（qq_speak 工具依赖 127.0.0.1:3210；已在跑则跳过）
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\dsh work\tts-runtime\start-tts.ps1"
:loop
node src/bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    rem 已经有一个实例在跑：显示原因，等几秒让双击启动的人看清，然后退出。
    rem 这里不能用 pause —— 守护脚本会停在按键提示上，桥接死了也不会自动重启。
    echo [%date% %time%] bridge already running in another window. Exiting.
    ping -n 9 127.0.0.1 >nul
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
ping -n 6 127.0.0.1 >nul
goto loop
