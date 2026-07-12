# Task: 假脸线换路线——推理期独立交叉校验 / 模块剥离（不再靠加数据）

## 背景与定论（必读）

假脸线（student 在风景/产品/空场景幻视人脸）已经过 **v12→v13→v14 三轮蒸馏迭代**，方向正确（独立 falseFaceRisk 头 vs 旧 `1-faceValidity` 派生量，srcc 从 −0.65 翻到 +0.67）。但在同一 84 张零重叠独立 holdout 上：

| 版本 | AUC | TPR@0.5 |
|---|---:|---:|
| v12 | 0.1765 | 0% |
| v13 | 0.3123 | 0% |
| v14（+五台山 2525 张 + 506 区域监督）| 0.4778 | 0% |

AUC **单调爬向 0.5（随机）但从未越过**，TPR@0.5 一直 0%——本质是"从反相变成随机，但零检出"，独立头只是贴低先验、根本不判别。v14 又加了 2525 张高发域数据 + 区域监督，**五台山只贡献 19/506 个 region，整图 hard-negative 仍近零**，AUC 仍卡在 chance。

**结论：瓶颈不是数据量。** 三轮加数据/加区域监督已证明"小 student + 全局蒸馏特征"这条路对假脸判别无效。**下一轮不许再用"加数据/加区域监督重训 student"作为主路线。**

## 目标

换根本思路，让"假脸"判别真正可用（在 84 holdout 上 AUC 明显 >0.5、TPR@0.5 非零、正样本组 risk > 对照组），同时不破坏召回。优先尝试**推理期独立交叉校验**，并评估**把假脸剥离为独立模块**的可行性。

## 不可动的硬约束（先读）

- **84 张独立 holdout 永不进训练/调参**：output/semantic-false-face-diagnosis/v13-eval/independent-false-face-set.csv（54 假脸正样本 + 30 真人脸对照）。
- **评估口径与 v12/v13/v14 完全一致、可比**：同一 84 holdout，报 AUC / TPR@0.5 / FPR@0.5、正样本 vs 对照 risk 分布。新路线的输出分数要能放进同一张对比表。
- **不再靠蒸馏加数据救假脸**：本轮主路线是推理期机制或独立模块，不是重训 student 的整图/区域监督。
- 不动 backbone、teacher prompt、不重标注；若涉及 merged teacher 仍跑前校验 SHA。
- **诚实优先**：若交叉校验/独立模块仍不达标，如实写"假脸判别在当前资源下不可解"，给出代价分析，不许贴低先验凑均值假装收敛。

## 候选路线（择优实现，A 优先）

### 路线 A：推理期独立人脸存在性交叉校验（不走蒸馏）

思路：student 仍出召回/美学分，**假脸不再靠 student 头**。推理期额外挂一个独立、现成的人脸存在性/检测信号（如轻量人脸检测器或独立人脸 embedding 的存在性判定），用"检测说无脸 + student/teacher 说像脸"这组冲突来判 false-face。

1. 选 1~2 个现成、可本地跑的人脸存在性信号（明确选型理由、体积、延迟）。
2. 在 84 holdout 上单独评估该信号：假脸正样本（应判"无真脸"）vs 真人脸对照（应判"有真脸"）的可分性，出 AUC/TPR/FPR。
3. 设计交叉校验逻辑：把"人脸存在性"与现有 falseFaceRisk/faceValidity 信号组合成最终 false-face 判定，调阈值。
4. 输出该组合在 84 holdout 上的可比指标。

### 路线 B：假脸剥离为独立模块（小专用判别器，仍不进 student 蒸馏）

仅在路线 A 不足时启用。

1. 用区域级 crop（teacher faceRegionVerdicts 里 isRealHumanFace=false 的 region + 真人脸 region 做正负）训一个**独立小判别器**，专做"这块像脸但不是脸 / 是真脸"的二分类，与 student 解耦。
2. 注意：训练数据仍不得含 84 holdout 的任何 photoId。
3. 84 holdout 上同口径评估。

### 共同要求

- 无论 A/B，最终都要在**同一 84 holdout**上给出与 v12/v13/v14 同口径的对比表。
- 评估对召回的影响：接上新假脸判定后，recall@38/45/50/60 与 negative pick rate 是否回退（@45 回退应 < 2pp，超了要说明）。

## 达标线

- 84 holdout：AUC 明显 >0.5（目标 ≥0.7），假脸正样本组 risk/判定 > 真人脸对照组（排序转正），**TPR@0.5 非零**。
- 召回不因接入假脸判定明显回退。
- 若达不到：诚实结论 + 代价分析（要达标需要什么：更强检测器？更大模型？更多人工标注？），不强行宣称闭环。

## 验收标准

- [ ] 选定路线（A 优先）并说明选型理由、体积/延迟代价
- [ ] 人脸存在性信号 / 独立判别器在 84 holdout 上单独评估（AUC/TPR/FPR）
- [ ] 交叉校验/模块组合后的最终 false-face 判定，在同一 84 holdout 上出 v12/v13/v14/本轮可比对比表
- [ ] 接入后召回回退评估（@45 < 2pp 或说明）
- [ ] 训练/调参未使用 84 holdout 任何 photoId
- [ ] 诚实判定：是否首次产生真实检出（TPR@0.5 非零、AUC>0.5）；达不到则给代价分析

## 输出文件

```
output/semantic-false-face-diagnosis/v15-crosscheck/
  approach-selection.md                    # 路线选型 + 代价
  face-presence-eval.json                  # 独立人脸存在性信号在 84 holdout 的可分性
  crosscheck-scores.csv                    # 组合后判定在 84 holdout 的分数
  false-face-generalization-report-v15.md  # v12/v13/v14/v15 同 holdout 可比 + 闭环判定 + 召回回退
```
