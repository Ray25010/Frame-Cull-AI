@echo off
cd /d "%~dp0\\..\\.."
set PY=C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe
"%PY%" tools\pro-train\review_false_face_phase3_shortlist.py --summary-json output\semantic-false-face-diagnosis\v13-eval\phase3-hard-negative-shortlist.review-summary.json
if errorlevel 1 pause
