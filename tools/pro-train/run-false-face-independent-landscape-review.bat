@echo off
setlocal
set PY=C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe
"%PY%" tools\pro-train\review_false_face_independent_candidates.py ^
  --input-csv output\semantic-false-face-diagnosis\v13-eval\scene-gap-review\landscape-gap-seed.csv ^
  --summary-json output\semantic-false-face-diagnosis\v13-eval\scene-gap-review\landscape-gap-seed.review-summary.json
