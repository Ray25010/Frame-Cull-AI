# FrameCull Pro 论文留档说明

这个工具是给 `Semantic Teacher / Student Lab` 留论文材料用的。

它会把两类东西一起收下来：

1. 5090 服务器上的训练日志、评估结果、报告、样例图、导出 manifest
2. 本地仓库里的诊断材料、任务文档、goal prompt、关键训练/评估脚本

这样后面写论文时，不会出现“结果在服务器上，分析在本地，脚本又找不到是哪版”的情况。

## 默认会收什么

- 训练和评估日志
- Markdown 报告
- JSON / CSV 指标
- teacher / eval 样例图
- QA 报告、license 结论、训练报告、ablation 报告
- 当前服务器状态、GPU、远端 git 状态
- 当前本地 git 状态
- false-face 诊断目录
- 当前任务文档和关键脚本副本

## 默认不会收什么

- `*.pt`
- `*.onnx`
- `*.npz`
- `*.jsonl`

这些大文件先默认不带，避免本地磁盘被拖满。需要时可以用参数单独打开。

## 运行方法

最省事的方式是直接跑这个一键脚本：

```powershell
powershell -ExecutionPolicy Bypass -File tools\pro-train\capture_semantic_paper_snapshot.ps1 -Tag current
```

它会在当前会话里询问服务器密码，然后调用稳定 Python 去抓快照。

## 手动运行

先在 PowerShell 里设置服务器密码：

```powershell
$env:FC_SSH_PASS = '你的服务器密码'
```

然后用稳定 Python 运行：

```powershell
& 'C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  tools\pro-train\collect_semantic_teacher_paper_artifacts.py
```

默认输出目录：

```text
output\paper-artifacts\semantic-teacher-lab\
```

每次运行都会新建一个带时间戳的快照目录，并额外打一个 zip。

## 常用参数

一键脚本同样支持这些参数，比如：

```powershell
powershell -ExecutionPolicy Bypass -File tools\pro-train\capture_semantic_paper_snapshot.ps1 `
  -Tag after-student `
  -IncludeJsonl `
  -IncludeModels
```

下面这些是底层 Python 脚本参数：

带上完整 teacher jsonl：

```powershell
& 'C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  tools\pro-train\collect_semantic_teacher_paper_artifacts.py `
  --include-jsonl
```

带上导出的 ONNX：

```powershell
& 'C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  tools\pro-train\collect_semantic_teacher_paper_artifacts.py `
  --include-models
```

连 checkpoint 也留档：

```powershell
& 'C:\Users\29238\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  tools\pro-train\collect_semantic_teacher_paper_artifacts.py `
  --include-checkpoints
```

## 快照里至少会有什么

- `README.md`
- `manifest.json`
- `artifact-index.csv`
- `paper-summary.json`
- `paper-summary.md`
- `provenance/semantic-teacher-status.txt`
- `provenance/active-jobs.txt`
- `provenance/gpu.txt`
- `provenance/workspace-head.txt`
- `provenance/workspace-status.txt`
- `provenance/local-workspace-head.txt`
- `provenance/local-workspace-status.txt`
- `remote/...` 下面的服务器产物
- `workspace/...` 下面的本地诊断、文档和脚本副本

其中：

- `manifest.json` 是完整留档清单，适合追溯“这次到底收了哪些文件”
- `paper-summary.json` 是结构化摘要，适合后面做表格、画图、抽指标
- `paper-summary.md` 是人直接读的速记版，适合写论文时先快速回忆这一轮结果

根目录还会持续追加一个：

- `snapshot-history.jsonl`

它会把每次快照的时间、路径、下载统计和关键阶段指标串起来，后面做“多轮实验时间线”会方便很多。

## 使用建议

- 训练开始前收一次，记录初始状态
- teacher 跑完后收一次
- student 跑完后收一次
- eval / ablation 跑完后再收一次完整快照

建议固定用下面这几个 tag，后面写论文会很整齐：

- `before-run`
- `after-teacher`
- `after-student`
- `after-export`
- `after-eval`
- `final`

如果某些阶段还没产出，对应文件会在 `manifest.json` 里标成 `missing`，不会让整次收集失败。
