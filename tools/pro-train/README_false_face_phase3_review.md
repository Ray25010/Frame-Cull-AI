# Phase 3 假脸 shortlist 审核器

这个工具只做一件事：把 `phase3-hard-negative-shortlist.csv` 的人工确认入口变简单。

它不会：

- 修改 teacher JSONL
- 生成 patch
- 启动训练

它只会：

- 逐张显示 shortlist 图片
- 让你填写这 4 个字段
  - `humanConfirmUseForTraining`
  - `humanConfirmHasRealHumanFace`
  - `humanConfirmScene`
  - `humanConfirmIllusionReason`
- 保存回 CSV
- 同步写出 `phase3-hard-negative-shortlist.review-summary.json`
  - `completedRows`: 4 个必填字段都已填完的行数
  - `readyForPatchCount`: 已满足 `use=true + hasRealHumanFace=false + scene/reason 非空` 的行数
- 默认自动保存
- 默认优先跳到第一条未完成的条目
- 顶部固定显示：
  - `上一张`
  - `下一张`
  - `下一个未填`
  - `保存`
- 提供快速标记按钮：
  - `可训练假脸`
  - `真人脸/不训练`
  - `无人脸/不训练`
  - `填建议场景`
  - `填默认原因`
- 支持快捷键：
  - `Left / Right`：上一张 / 下一张
  - `Ctrl+S`：保存
  - `Ctrl+Shift+N`：跳到下一条未完成
  - `Ctrl+1`：一键标成 `可训练假脸` 并跳下一张
  - `Ctrl+2`：一键标成 `真人脸/不训练` 并跳下一张
  - `Ctrl+3`：一键标成 `无人脸/不训练` 并跳下一张

## Windows 运行

双击：

`tools\pro-train\run-false-face-phase3-review.bat`

默认会打开：

`output\semantic-false-face-diagnosis\v13-eval\phase3-hard-negative-shortlist.csv`

同时会更新：

`output\semantic-false-face-diagnosis\v13-eval\phase3-hard-negative-shortlist.review-summary.json`

## 命令行运行

```powershell
C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe `
  tools\pro-train\review_false_face_phase3_shortlist.py
```

如果想另存为一份副本：

```powershell
C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe `
  tools\pro-train\review_false_face_phase3_shortlist.py `
  --output-csv output\semantic-false-face-diagnosis\v13-eval\phase3-hard-negative-shortlist.reviewed.csv
```

如果你不想自动保存：

```powershell
C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe `
  tools\pro-train\review_false_face_phase3_shortlist.py `
  --no-autosave
```

## 审核建议

- `humanConfirmUseForTraining=true` 只给那些**真的很像脸**、而且 **图中没有真人脸** 的样本
- 如果图里有真人脸，`humanConfirmHasRealHumanFace=true`
- `humanConfirmIllusionReason` 尽量写清楚为什么会幻视，比如：
  - kayak cockpit holes
  - hood and rain gear forming eye-like circles
  - product contour resembles eyes and mouth
  - rock / cloud / branch pattern resembles face

## 后续链路

人工确认完成后，先确认 `phase3-hard-negative-shortlist.review-summary.json` 里的：

- `completedRows` 已经覆盖你想审完的范围
- `readyForPatchCount` 已经不是 0

然后下一步不是手改别的文件，而是直接跑：

1. `build_false_face_v13_teacher_patch.py`
2. `merge_semantic_teacher_patch.py`
3. `train_semantic_student.py`
4. 同一独立集复测 `v12 vs v13`
