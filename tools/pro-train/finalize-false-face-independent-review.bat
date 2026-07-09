@echo off
setlocal
set PY=C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe
set EVAL=output\semantic-false-face-diagnosis\v13-eval

"%PY%" tools\pro-train\merge_false_face_independent_review.py ^
  --base %EVAL%\independent-false-face-set.csv ^
  --reviewed %EVAL%\wutai-landscape-food-seed.csv ^
  --output %EVAL%\independent-false-face-set.merged.csv ^
  --summary-json %EVAL%\independent-false-face-set.merge-summary.json
if errorlevel 1 exit /b %errorlevel%

"%PY%" tools\pro-train\prepare_false_face_holdout_previews.py ^
  --independent-set %EVAL%\independent-false-face-set.merged.csv ^
  --output-dir %EVAL%\upload-previews-384 ^
  --summary-json %EVAL%\upload-previews-384.summary.json
if errorlevel 1 exit /b %errorlevel%

"%PY%" tools\pro-train\check_false_face_independent_overlap.py ^
  --teacher-jsonl output\semantic-false-face-diagnosis\semantic-teacher-v1.1-merged.jsonl ^
  --independent-set %EVAL%\independent-false-face-set.merged.csv ^
  --output-json %EVAL%\overlap-check.merged.json
if errorlevel 1 exit /b %errorlevel%

"%PY%" tools\pro-train\plan_false_face_v13_retrain.py ^
  --independent-set %EVAL%\independent-false-face-set.merged.csv ^
  --output-dir %EVAL%\merged-holdout-plan
if errorlevel 1 exit /b %errorlevel%

copy /Y %EVAL%\independent-false-face-set.csv %EVAL%\independent-false-face-set.before-merge.csv >nul
copy /Y %EVAL%\overlap-check.json %EVAL%\overlap-check.before-merge.json >nul
copy /Y %EVAL%\independent-false-face-set.merged.csv %EVAL%\independent-false-face-set.csv >nul
copy /Y %EVAL%\overlap-check.merged.json %EVAL%\overlap-check.json >nul
copy /Y %EVAL%\merged-holdout-plan\v13-holdout-photoids.txt %EVAL%\v13-holdout-photoids.txt >nul

"%PY%" tools\pro-train\rebuild_false_face_independent_audit.py ^
  --independent-set %EVAL%\independent-false-face-set.csv ^
  --source-json %EVAL%\v12-generalization-raw.json ^
  --source-json %EVAL%\v13-generalization-raw.json ^
  --output %EVAL%\independent-v13-audit.json ^
  --summary-json %EVAL%\independent-v13-audit.rebuild-summary.json
if errorlevel 1 exit /b %errorlevel%

"%PY%" tools\pro-train\audit_false_face_v13_completion.py
echo.
echo If completion audit now only fails because v12/v13 scores are stale, rerun the server holdout inference/report chain.
