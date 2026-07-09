# Task: 五台山数据接入 + v14 假脸区域监督（双线）

## 背景

新增五台山批次：2525 张已用 Qwen2.5-VL grounded teacher 全量标注（0 失败），特征也已备齐。
- teacher 标注：`/data/FrameCullModelLab/features/semantic-teacher/five-mountain-grounded.jsonl`
- 特征：`/data/FrameCullModelLab/features/teacher/teacher-five-mountain.npz`（CLIP 2525×512、DINOv2 2525×768、MUSIQ tech、MUSIQ-AVA）
- 现有训练全集：`/data/FrameCullModelLab/features/semantic-teacher/semantic-teacher-v1.1-merged.jsonl`（6475 条，SHA256 `04f5527f8bc6922a743d20cefd5b537c6cf87882d119d20581b2b81985c62059`）

这批数据同时服务两条线：(A) 扩训练集提升召回；(B) 作 v14 假脸 hard-negative + 区域监督来源。五台山是山景/岩石/雕像/寺庙——假脸高发域，理论上是 hard-negative 金矿，但 teacher 用的是收紧后的保守 prompt，**实际含多少可用 hard-negative 必须先清点**（前几轮栽在"以为有、实际只有 2 张"）。

## 假脸线现状（必读）

v13 已用 84 张零重叠独立集证实：独立 `falseFaceRisk` 头**未泛化**——v12 AUC 0.1765 / v13 0.3123，**均 <0.5（排序反相）**，假脸正样本 risk 均值反而低于真人脸对照，TPR@0.5=0%，根因是训练里真假脸样本几乎为零。独立头方向对，但缺正样本可学。

## 不可动的硬约束（先读）

- **84 张独立 holdout 永不进训练**：`output/semantic-false-face-diagnosis/v13-eval/independent-false-face-set.csv` 里的 photoId 一律留出。Phase 0 先做交集校验，五台山 ∩ holdout 必须 = 0；五台山 ∩ 现有 6475 也要查重，去重。
- **同一 84 holdout 上报 v12/v13/v14 可比 AUC**：评估口径、独立头定义与 v13 完全一致，不许换口径。
- **区域/crop 级监督，不是整图贴标签**：v14 的核心增量是让 student 看到"哪里像脸但不是脸"，用 teacher grounded 标注里的 `faceRegionVerdicts`（isRealHumanFace=false 的 region）和 `reasoningTrace` region 做局部负监督。
- **不动 backbone、不动 teacher prompt、不重标注**。merged teacher 跑前校验 SHA。
- 诚实优先：召回不许回退凑假脸、假脸不许贴低先验凑均值。两条线分别如实判定。

## 实现步骤

### Phase 0: 清点 + 去重 + 交集校验

1. 解析 `five-mountain-grounded.jsonl`：统计 scene 分布、`hasRealHumanFace` 真假比例、**hard-negative 数量**（hasRealHumanFace=false 且 falseFaceRisk≥0.5）、含 face-like region（faceRegionVerdicts 里 isRealHumanFace=false）的样本数。
2. photoId 交集校验：五台山 ∩ 84-holdout = 0（强制）；五台山 ∩ 6475 去重。
3. 输出 `output/semantic-false-face-diagnosis/v14/five-mountain-inventory.json`。
   - **决策点**：若 hard-negative + face-like region 样本数仍只有个位数，则 v14 假脸监督主要靠"区域级负监督"（从 face-like region 抠 crop 当负样本），而非靠整图 hard-negative 计数。报告里写明实际可用量。

### Phase 1: 合并训练集（双线共用）

1. 合并 6475 + 五台山（去重后）→ 新 merged teacher jsonl，记录新 count 与 SHA256。
2. 84-holdout 的 photoId 强制排除。
3. 重新 train/val split，记录各 scene、hard-negative 在 train/val 的分布。
4. 输出合并报告 `output/semantic-false-face-diagnosis/v14/merge-report-v14.json`。

### Phase 2: v14 假脸区域监督实现

1. 从 teacher grounded 标注提取 face-like 但非真脸的 region（isRealHumanFace=false 的 faceRegionVerdicts.region），构造**区域级负监督信号**——让 falseFaceRisk 头/faceValidity 头在这些 region 的局部特征上学到"像脸但不是脸→高假脸风险"。
2. 保留 v12/v13 的独立 falseFaceRisk 头设计（已证方向对）。
3. 记录区域监督的实现方式与覆盖样本数到 training-report-v14。

### Phase 3: 重训 student v14

- 仅重训 student，backbone/teacher prompt 不动，merged teacher SHA 跑前校验。
- 同时训练召回相关头 + 独立 falseFaceRisk 头（带区域监督）。
- 新版本号 v14。

### Phase 4: 双线评估

**(A) 召回线**：全量 eval，报 recall@38/45/50/60、negative pick rate，对比 v12/v13/persona-v1/当前 production。判定召回是否提升、是否回退。

**(B) 假脸线**：用**同一 84 holdout**，同 v13 口径，报 v12/v13/v14 的：
- 假脸正样本 vs 真人脸对照的 risk 分布（均值/中位/P25/P75）
- AUC、TPR@0.5、FPR@0.5
- 达标线：AUC 明显 >0.5（目标 ≥0.7）、正样本 risk 组 > 对照组（排序转正）、TPR@0.5 非零
- 漏判样本 top 列表

### Phase 5: 报告

- `output/semantic-false-face-diagnosis/v14/false-face-generalization-report-v14.md`：假脸三代（v12/v13/v14）同 holdout 可比指标 + 闭环/未闭环判定 + 区域监督是否起效。
- `output/semantic-false-face-diagnosis/v14/recall-report-v14.md`（或并入）：召回对比 + 是否回退。
- 明确两条线各自结论，诚实标注仍失败的场景。

## 验收标准

- [ ] five-mountain 清点完成（scene/hasRealHumanFace/hard-negative/face-like region 计数）
- [ ] 五台山 ∩ 84-holdout = 0，∩ 6475 已去重，均写明
- [ ] 合并训练集生成，84-holdout 强制排除，SHA 记录
- [ ] v14 区域级假脸负监督实现并记录覆盖量
- [ ] 仅重训 student，merged teacher SHA 校验通过
- [ ] 召回线：recall@多比例 + negative pick rate，对比基线，判定是否回退
- [ ] 假脸线：同 84 holdout 报 v12/v13/v14 可比 AUC/TPR，明确是否泛化/闭环
- [ ] 两条线诚实结论，失败场景如实标注

## 输出文件

```
output/semantic-false-face-diagnosis/v14/
  five-mountain-inventory.json             # Phase 0 清点 + 决策点
  merge-report-v14.json                    # 合并 + 去重 + holdout 排除校验
  training-report-v14.json                 # SHA 校验 + 区域监督覆盖 + 新 hard-negative 数
  v14-generalization-scores.csv            # v14 在 84 holdout 上的 risk
  false-face-generalization-report-v14.md  # v12/v13/v14 同 holdout 可比 + 判定
  recall-report-v14.md                     # 召回对比（或并入上一份）
```
