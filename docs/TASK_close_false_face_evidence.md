# Task: 闭环验证 v11 假脸修复（学生层全量证据）

## 背景

Semantic Teacher false-face 修复（v11-false-face）已完成 prompt 收紧 + merged teacher 重训 + 全量评估。审计确认：
- Teacher prompt 已实质收紧（排除岩石/树干/云朵/雕像/头盔骑手/侧背影等假脸源，landscape/documentary/product_object 场景专项约束）
- Merge 干净（6475 基线，200 替换，0 匹配失败）
- 学生重训 + 全量评估（5167 张）跑完，召回不降反升（45%: 54.46%→56.85%，60%: 71.13%→73.29%）

## 问题：证据链缺口

审计发现"假脸修复"的核心证据没有归档：

1. **现有 `fix-validation-report.md` 的 `-0.4602` 不是原问题口径**
   - 原审计的 "+0.3032 假脸恶化" 是**学生层、全量、scene-mean** 的 false_face_risk
   - 但 `fix-validation-report` 的 `-0.4602` 是**teacher 标注层、200 张补丁子集**上的，且基线被编码成 grounded=0.000 / flat 固定=0.500（delta 恒为 -0.5）
   - 两者不是同一度量，不能互相替代

2. **学生层全量假脸产物没归档**
   - v11 全量评估生成了 `metrics-by-scene.csv` 和 `false-face-samples.csv`，但留在远程 `/data/FrameCullModelLab/outputs/semantic-teacher-lab/eval-full/bench-grounded-v11-false-face/`
   - 没有被复制进 `output/semantic-false-face-diagnosis/v11-final/`
   - 归档里的 `grounded-vs-flat-ablation.md` 只是占位 stub（指向远程目录，没有实际数字）

## 目标

补齐学生层全量假脸改善的可查证据，回答："v11 收紧后，学生模型在全量 5167 张上的 scene-mean false_face_risk，是否真的不再比 flat 差、且比旧 grounded 改善？"

**不需要重跑任何训练或评估**——所有数据已存在于远程目录，只需归档 + 对比分析。

## 实现步骤

### Step 1: 归档已有产物

从远程 `bench-grounded-v11-false-face/` 复制以下文件到 `output/semantic-false-face-diagnosis/v11-final/`：
- `metrics-by-scene.csv`
- `false-face-samples.csv`
- `metrics-by-ratio.csv`（如与现有不同则覆盖，相同则跳过）

如果远程目录已被清理、文件不存在，则必须重跑 v11 全量评估的 audit/summary 步骤重新生成（仅评估，不重训）。

### Step 2: 三方 scene 级假脸对比

构造一张表，对每个场景（landscape/documentary_moment/event/group/portrait/product_object/other）报告 `false_face_risk_mean`，三方对比：

| Scene | Flat | 旧 Grounded (v1) | 新 Grounded (v11) | v11 vs Flat | v11 vs 旧Grounded |
|---|---|---|---|---|---|

数据来源：
- Flat: `eval-full/bench-flat/metrics-by-scene.csv`
- 旧 Grounded (v1): `eval-full/bench-grounded/metrics-by-scene.csv`（审计报告里记录的旧值：landscape 0.5753, documentary 0.3919, product_object 0.9956）
- 新 Grounded (v11): Step 1 归档的 `bench-grounded-v11-false-face/metrics-by-scene.csv`

### Step 3: 重新计算原问题口径的 delta

用学生层全量 scene-mean 重新算"grounded - flat"的 false-face proxy delta（原审计的 +0.3032 就是这个口径），对比 v1 和 v11：
- v1: landscape/documentary 平均 delta = +0.3032（恶化）
- v11: 目标 < +0.05（不劣于 flat）

如果 v11 的学生层全量 delta 仍然明显为正（比 flat 差），说明 teacher 标注层的修复**没有传导到学生层**，需要在报告中明确指出，并标记为"修复未闭环"。

### Step 4: 输出真正的闭环验证报告

替换占位 stub，写一份带真实数字的报告 `v11-final/false-face-closure-report.md`，包含：
- Step 2 的三方对比表
- Step 3 的口径对齐 delta（v1 vs v11）
- 明确结论：学生层全量假脸是否改善（是/否/部分），分场景说明
- 召回 trade-off 复述（已知 +14.66% @45%）
- 诚实标注任何仍未达标的场景（如 product_object 旧值 0.9956 是否降下来）

## 验收标准

- [ ] `metrics-by-scene.csv` 和 `false-face-samples.csv` 已归档进 v11-final
- [ ] 三方 scene 级假脸对比表完成（flat / 旧grounded / 新grounded）
- [ ] 用原问题口径（学生层全量 scene-mean grounded-flat delta）重算 v1 vs v11
- [ ] 明确回答学生层假脸是否改善，分场景诚实标注
- [ ] `grounded-vs-flat-ablation.md` 占位 stub 被替换为带真实数字的内容，或新增 closure-report

## 关键约束

- **不要重跑训练**。学生权重已固化（v11-false-face）。
- **不要重跑全量推理**，除非远程 csv 确实丢失。
- **不要篡改对比口径凑数**。如果学生层全量 delta 仍为正（比 flat 差），必须如实报告"teacher 修复未充分传导到学生层"，而不是用 teacher 子集的 -0.46 掩盖。
- 诚实优先于好看。这份报告的目的是给出可信的产品候选决策依据。

## 输出文件

```
output/semantic-false-face-diagnosis/v11-final/
  metrics-by-scene.csv                    # 归档（从远程复制）
  false-face-samples.csv                  # 归档（从远程复制）
  false-face-closure-report.md            # 三方对比 + 口径对齐 delta + 诚实结论
  grounded-vs-flat-ablation.md            # 替换占位 stub 为真实数字
```
