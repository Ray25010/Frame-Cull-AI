@echo off
setlocal
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run-five-mountain.ps1"
if errorlevel 1 exit /b %errorlevel%
echo.
echo Press Enter to close.
pause >nul
