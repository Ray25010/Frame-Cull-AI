# FrameCull Arbor R&D Workspace

这个目录是 FrameCull Pro / AI 研发的 Arbor 风格工作区。

它只做三件事：

1. 记录研发合同、指标、数据、实验与结论。
2. 给后续 teacher / student / pick-ranker 实验提供可追溯的 Idea Tree。
3. 给论文写作保留稳定入口。

它不做三件事：

1. 不移动 `src/`、`src-tauri/`、`tools/`、`output/` 里的现有文件。
2. 不替代软件开发工作区。
3. 不把大模型、训练缓存、原图数据复制进来。

## 目录

- `ARBOR_CONTRACT.md`: 本研发工作区的约束和目标。
- `research_config.yaml`: Arbor 风格机器可读配置。
- `.arbor/sessions/`: 每次研究 run 的 Idea Tree、报告和事件。
- `registry/`: 数据、指标、产物、保护路径索引。
- `experiments/`: 手工或后续 executor 写的实验卡片。
- `benchmarks/`: benchmark 入口说明，不存放大数据。
- `paper/`: 论文写作入口和快照索引。

## 当前主线

当前主线不是继续调产品 UI，而是研究：

- heavy teacher 如何产生可解释语义标签；
- student 蒸馏后哪些信号能传导，哪些不能；
- Pro 模型能否提升低比例精选召回；
- false-face 风险如何从 teacher 层传导到 student 层；
- 哪些结果可以写成论文证据，哪些只能作为负结果。

## 快速入口

- 最新论文快照：`../../output/paper-artifacts/semantic-teacher-lab/latest-snapshot.json`
- 最新论文摘要：`../../output/paper-artifacts/semantic-teacher-lab/latest-paper-summary.md`
- false-face v11 闭环报告：`../../output/semantic-false-face-diagnosis/v11-final/false-face-closure-report.md`
- Pro Semantic Teacher 任务书：`../../docs/GOAL_pro_semantic_teacher_lab.md`
- false-face 修复任务：`../../docs/TASK_fix_semantic_false_face.md`
- false-face 闭环任务：`../../docs/TASK_close_false_face_evidence.md`

## 工作规则

新增实验先写 `experiments/<date>-<name>.md` 或进入 `.arbor/sessions/<run>/`。

实验通过后再考虑是否进入 `tools/` 或产品代码。产品代码改动仍走正常开发流程，不在这个目录直接“顺手改”。
