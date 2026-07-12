# Paper Evidence Entry

论文相关证据优先从这里进入：

1. `../../output/paper-artifacts/semantic-teacher-lab/latest-paper-summary.md`
2. `../../output/paper-artifacts/semantic-teacher-lab/latest-snapshot.json`
3. `../../output/paper-artifacts/semantic-teacher-lab/snapshot-history.jsonl`
4. `../../output/semantic-false-face-diagnosis/v11-final/false-face-closure-report.md`

## 写作口径

- 正结果：semantic / persona 路线对低比例召回有提升迹象。
- 负结果：false-face teacher prompt 子集有效，但 student 层没有充分传导。
- 边界：不要把 teacher 子集 `-0.4602` 写成 full student 闭环。
- 生产边界：Pro semantic 仍是实验候选，不是默认生产策略。

## 下一轮论文需要补的证据

- 更干净的 held-out test set。
- product_object / documentary_moment / event 的 false-face 专项验证集。
- student loss reweighting 前后对比。
- 模型大小、耗时和召回三者 trade-off 曲线。
