@echo off
chcp 65001 >nul
cd /d "%~dp0"
rem Keep this file ASCII-only: cmd.exe parses .bat with the OEM codepage, so
rem UTF-8 Chinese comments get treated as garbage commands (real incident:
rem WMI-launched supervisor died with "'X' is not recognized as a command").
rem Harden state/ ACLs (never blocks startup; prints a fix command on denial).
rem See docs/guides/SECURITY_BASELINE.md ("secrets at rest").
node scripts\harden-state-acl.mjs --quiet
rem Start local TTS service (qq_speak needs 127.0.0.1:3210; skips if running).
powershell -NoProfile -ExecutionPolicy Bypass -File "C:\dsh work\tts-runtime\start-tts.ps1"
:loop
node src\bridge.js
set code=%errorlevel%
if "%code%"=="2" (
    rem Already running in another window: show why, wait a bit, then exit.
    rem No pause here - a pause would freeze the supervisor loop.
    echo [%date% %time%] bridge already running in another window. Exiting.
    ping -n 9 127.0.0.1 >nul
    exit /b 2
)
echo [%date% %time%] bridge exited (code %code%), restarting in 5 seconds...
ping -n 6 127.0.0.1 >nul
goto loop
