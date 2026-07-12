# Metric Map

## Pick Quality

| Metric | Direction | Meaning | Current Evidence |
|---|---:|---|---|
| low-ratio recall | maximize | 人工可用片在 AI Pick 中被覆盖的比例 | `output/.../summary.md` and `metrics-by-ratio.csv` |
| negative pick rate | minimize | 0 星/无星/淘汰片混入率 | `metrics-by-ratio.csv` |
| duplicate pollution | minimize | 重复/连拍非代表混入 | `duplicate-pollution*.csv` |
| selected similar adjacent pairs | minimize | 相邻相似图被同时选中数量 | `metrics-by-ratio.csv` |

## Semantic / False-Face

| Metric | Direction | Meaning | Current Evidence |
|---|---:|---|---|
| false_face_risk_mean | minimize | 每个 scene 的假脸风险均值 | `metrics-by-scene.csv` |
| student-layer grounded-flat delta | minimize | 学生层全量 `grounded - flat` false-face risk | `false-face-delta-summary.json` |
| face verdict coverage | maximize | teacher 是否真正给出 face-region 判据 | `teacher-quality-report.json` |
| uncertain rate | minimize | teacher 输出不确定比例 | `teacher-quality-report.json` |

## Performance / Packaging

| Metric | Direction | Meaning | Current Evidence |
|---|---:|---|---|
| latency ms/image | minimize | Pro 推理单图耗时 | `pro-infer-latency.csv` |
| model bytes | minimize | fp32/int8 模型大小 | `export-report.json` |
| active EP | descriptive | CPU / DirectML / CUDA 实际后端 | `summary.md` |

## Current Anchors

- Semantic best recall at 45%: `56.85%`.
- Current production recall at 45%: `42.19%`.
- Semantic recall trade-off: `+14.66% @45%`.
- False-face v1 original delta: `+0.3032`.
- False-face v11 original delta: `+0.2883`.
- False-face target: `< +0.05`.
- False-face status: not closed.
