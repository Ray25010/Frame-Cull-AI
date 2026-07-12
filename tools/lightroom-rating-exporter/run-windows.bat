@echo off
cd /d "%~dp0"
py -3 lightroom_rating_exporter.py --gui
if errorlevel 1 (
  python lightroom_rating_exporter.py --gui
)
pause
