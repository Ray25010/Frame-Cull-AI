@echo off
setlocal
set PY=C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe
set EVAL=output\semantic-false-face-diagnosis\v13-eval

"%PY%" tools\pro-train\merge_false_face_independent_review.py ^
  --base %EVAL%\independent-false-face-set.csv ^
  --reviewed %EVAL%\scene-gap-review\landscape-gap-seed.csv ^
  --reviewed %EVAL%\scene-gap-review\food-2526-review-seed.csv ^
  --include-sample-role false_face_positive ^
  --max-false-face-positive 60 ^
  --max-real-face-control 30 ^
  --prioritize-missing-scenes ^
  --output %EVAL%\independent-false-face-set.scene-gaps-merged.csv ^
  --summary-json %EVAL%\independent-false-face-set.scene-gaps-merged.summary.json
if errorlevel 1 exit /b %errorlevel%

"%PY%" tools\pro-train\check_false_face_independent_overlap.py ^
  --teacher-jsonl output\semantic-false-face-diagnosis\semantic-teacher-v1.1-merged.jsonl ^
  --independent-set %EVAL%\independent-false-face-set.scene-gaps-merged.csv ^
  --output-json %EVAL%\overlap-check.scene-gaps-merged.json
if errorlevel 1 exit /b %errorlevel%

copy /Y %EVAL%\independent-false-face-set.csv %EVAL%\independent-false-face-set.before-scene-gaps.csv >nul
copy /Y %EVAL%\overlap-check.json %EVAL%\overlap-check.before-scene-gaps.json >nul
copy /Y %EVAL%\independent-false-face-set.scene-gaps-merged.csv %EVAL%\independent-false-face-set.csv >nul
copy /Y %EVAL%\overlap-check.scene-gaps-merged.json %EVAL%\overlap-check.json >nul

"%PY%" tools\pro-train\rebuild_false_face_independent_audit.py ^
  --independent-set %EVAL%\independent-false-face-set.csv ^
  --source-json %EVAL%\v12-generalization-raw.json ^
  --source-json %EVAL%\v13-generalization-raw.json ^
  --output %EVAL%\independent-v13-audit.json ^
  --summary-json %EVAL%\independent-v13-audit.rebuild-summary.json
if errorlevel 1 exit /b %errorlevel%

"%PY%" tools\pro-train\audit_false_face_v13_completion.py
