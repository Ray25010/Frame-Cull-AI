# Task: 学生层假脸修复 v12（改 student 蒸馏，不改 teacher prompt）

## 背景

v11-false-face 已确认**未闭环**（2026-06-26 审计）。证据链：
- 原始口径（学生层、全量 5167 张、scene-mean `grounded − flat` false-face delta，取 landscape+documentary 平均）从 v1 的 `+0.3032` 只降到 v11 的 `+0.2883`，净改善仅 `−0.0149`，目标 `< +0.05`。
- documentary_moment 反而比 v1 升高（+0.0279）；product_object 几乎满风险（v11 0.9996）。
- teacher patch 子集那个 `-0.4602` 只证明 200 张补丁上 teacher prompt 变保守了，**学生层没传导**。

**根因判定：问题在 student 层蒸馏传导，不在 teacher prompt。** teacher 标注（v1.1-merged，6475 条，SHA256 04f5527...）已经收紧且干净，本轮**不再动 teacher prompt，不重标注**。

关键现状（来自 training-report.json）：
- `falseFaceRisk` 当前是**派生量** `1 - faceValidityScore`，不是独立训练的头。
- faceValidity 头声称用 "falseFaceRisk-weighted hard-negative emphasis" 训练，但实际传导不足——加权力度或样本覆盖不够。

## 目标

让 student 在全量 5167 张上的原始口径 false-face delta 真正降下来，进入闭环。
**主目标：landscape+documentary scene-mean `grounded − flat` delta < +0.05**（当前 +0.2883）。
**约束：召回不得明显回退**（v11 当前 +14.66% @45%，本轮 @45% 召回回退不超过 2 个百分点）。

## 实现步骤

### Step 0: 传导失败诊断（先诊断，再动手）

不要直接堆 loss。先回答"student 为什么没学到 teacher 的保守判断"：
- 统计训练集中 false-face hard-negative 的数量与 scene 分布（teacher `hasRealHumanFace=false` 且 `falseFaceRisk` 高 / 视觉上 face-like 的样本）。看是不是样本太少或 scene 偏斜。
- 对 val/全量做误差分解：student 预测的 faceValidity vs teacher faceValidity，按 scene 看残差，定位是哪些 scene 的 hard-negative 被 student 拉高。
- 确认 `falseFaceRisk = 1 - faceValidity` 这个派生是否是瓶颈（teacher 的 falseFaceRisk 与 1-faceValidity 在标注层是否一致；若不一致，派生本身就丢信息）。
输出 `output/semantic-false-face-diagnosis/v12-student/transmission-diagnosis.md`。

### Step 1: 选择并实现 student 层修复（按诊断结果，至少做 1+2）

1. **faceValidity 头 hard-negative 损失重加权**：对 false-face hard-negative 样本加大损失权重（非对称：student 把"假脸判成真脸"的错误，惩罚要重于反向）。把当前加权力度显式调大并记录系数。
2. **高风险 scene 定向重采样**：对 landscape / documentary_moment / event / product_object 的 hard-negative 过采样，纠正 scene 偏斜。
3. **（可选，若 Step 0 判定派生是瓶颈）独立 falseFaceRisk 头**：新增直接回归 teacher `falseFaceRisk` 的头，导出时用独立头而非 `1 - faceValidity`。仅在诊断支持时做。

**不改 backbone（convnext_tiny / 384）、不改 teacher、不重标注。**

### Step 2: 重训 student（仅 student）

用同一 merged teacher（6475 条，SHA256 必须等于 04f5527...，跑前校验）重训。记录新权重版本号（如 v12-student-falseface）。

### Step 3: 全量评估 + 原始口径验证（口径必须与 v11 闭环报告完全一致）

- 跑全量 5167 张 eval，生成 `metrics-by-scene.csv` / `metrics-by-ratio.csv` / `false-face-samples.csv`。
- 用**与 false-face-closure-report.md 完全相同的口径**重算：学生层、全量、scene-mean `grounded − flat`，取 landscape+documentary 平均。对比 v1 / v11 / v12 三代。
- 三方→四方 scene 级对比表（flat / 旧grounded v1 / v11 / v12）。
- 复述召回 trade-off（@38/45/50/60）。

### Step 4: 诚实闭环报告

写 `output/semantic-false-face-diagnosis/v12-student/false-face-closure-report-v12.md`：
- 四代 scene 级对比表
- 原始口径 delta：v1 +0.3032 / v11 +0.2883 / v12 = ?，是否 < +0.05
- 召回回退是否 < 2pp @45%
- 分场景诚实结论（尤其 documentary_moment 是否止跌、product_object 0.9996 是否降下来）
- 明确判定：**闭环 / 未闭环 / 部分闭环**

## 验收标准

- [ ] `transmission-diagnosis.md` 完成，定位传导失败原因
- [ ] student 层修复实现（至少 hard-negative 重加权 + 高风险 scene 重采样）
- [ ] 仅重训 student，merged teacher SHA256 校验通过（04f5527...）
- [ ] 全量 eval 产物齐全（metrics-by-scene / by-ratio / false-face-samples）
- [ ] 原始口径 delta 重算（v1/v11/v12 同口径），明确是否 < +0.05
- [ ] 召回回退 < 2pp @45% 已核对
- [ ] closure-report-v12 给出闭环/未闭环明确判定，分场景诚实标注

## 关键约束

- **不动 teacher prompt，不重标注**。根因在 student 层。
- **不改 backbone**。
- **口径必须与 v11 闭环报告一致**（学生层、全量、scene-mean、landscape+documentary 平均），否则 v11→v12 不可比。
- **不许篡改口径凑数**。若 v12 仍未达标，如实写"未闭环"，并说明 student 层修复为何仍不够。
- 注意方法学坑：flat 与 grounded 的 scene 路由不同（同 scene 样本数差异大），"vs flat"列只能当趋势；"v12 vs v11"是干净对比。
- 诚实优先于好看。这份报告决定 v12 能否进产品候选。

## 输出文件

```
output/semantic-false-face-diagnosis/v12-student/
  transmission-diagnosis.md           # Step 0 诊断
  metrics-by-scene.csv                 # 全量 eval
  metrics-by-ratio.csv
  false-face-samples.csv
  false-face-scene-comparison-v12.csv  # 四代对比（机器可复算）
  false-face-delta-summary-v12.json
  false-face-closure-report-v12.md     # 闭环/未闭环判定
  training-report-v12.json             # 含 SHA256 校验、加权系数、重采样比例
```
