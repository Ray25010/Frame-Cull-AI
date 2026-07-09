# Task: 路线 B 独立 crop 假脸判别器（降 FPR + 换可判别前置 gate）

## 背景与现状（必读）

假脸线已走完两个阶段：

1. **蒸馏路线（v12-v14）废弃**：给 student 加三轮数据/区域监督，84 holdout AUC 只从 0.18 爬到 0.48（随机），TPR@0.5 一直 0%。小 student + 全局特征学不会这个判别。
2. **路线 A（v15 推理期 YuNet 交叉校验）锁为 guard-only**：84 holdout 条件 AUC 0.75 看着好，但全量 7692 replay 暴露两个致命问题：
   - 上游"疑似脸 gate"(`maxFacePresence>=0.08`)触发 99.60%，几乎对所有图敞开、**不具判别力** → 0.75 是"疑似脸上下文条件 AUC"，全量生产不成立。
   - YuNet 对真人脸 **36.7% 漏检** → 全量铺开大面积误伤真人脸（documentary_moment 1085 张触发、估 568 张是真人脸）。@45 自动剔除回退 29.48pp、降权 8.45pp，门槛 <2pp 无一过线。

本轮路线 B 目标就是攻这两个瓶颈：**(a) 把判别精度做上去（FPR 明显下来）、(b) 换一个真能分"疑似脸场景 vs 普通图"的前置 gate，而非敞开阈值。**

## 目标

训练一个**与 semantic student 解耦的独立小判别器**，输入是疑似脸区域的 crop，输出"这块是真脸 / 像脸但不是脸"的二分类。目标是在同一 84 holdout 上 AUC 不低于 v15（0.75），且**FPR 明显低于 36.7%**（目标 <15%），同时换掉敞开的上游 gate，最终在全量 7692 replay 上让 @45 recall 回退 <2pp、够格进自动拦截。

## 不可动的硬约束（先读）

- **84 张独立 holdout 永不进训练/调参/阈值拟合**：output/semantic-false-face-diagnosis/v13-eval/independent-false-face-set.csv。训练 crop 的来源 photoId 必须与 holdout 零交集，跑前做交集校验并写明。
- **不并回 semantic student、不动 backbone / teacher prompt**。路线 B 是独立模块，student 仍只出召回/美学分。
- **判别器训练数据用区域级 crop**：正样本=真人脸 region，负样本=teacher faceRegionVerdicts 里 isRealHumanFace=false 的 face-like region。训练集 photoId 不得含 holdout。
- **同口径可比**：同一 84 holdout 报 v12/v13/v14/v15/v15B 的 AUC / TPR@0.5 / FPR@0.5，放进同一对比表；不许换口径。
- **全量门槛固定**：接判别器后全量 7692 replay，@45 recall 回退必须 <2pp 才允许进自动拦截；超了如实判 guard-only。
- **诚实优先**：FPR 没压下来就如实写；不许用 holdout 条件值掩盖全量表现；前置 gate 触发率必须在全量上重新刻画（对比 v15 的 99.6%）。

## 实现步骤

### Phase 0: 训练数据构造 + 零重叠校验

1. 从训练图源抽 face-like region crop：正样本（真人脸）+ 负样本（isRealHumanFace=false 的 face-like region）。记录每类数量、scene 分布。
2. photoId 与 84 holdout 交集校验=0（强制），写进报告。
3. 输出 `output/semantic-false-face-diagnosis/v15b/crop-dataset-manifest.json`。
   - **决策点**：若负样本（像脸但不是脸的 region）数量太少不足以训判别器，如实写明，并说明补充来源（不得用 holdout）。

### Phase 1: 训练独立 crop 判别器

1. 选一个轻量 crop 分类 backbone（说明选型、体积、推理延迟，与 Flash 路线兼容性）。
2. 仅用 Phase 0 数据训练，holdout 全程留出。
3. 输出 training-report-v15b.json（含训练集 SHA、正负样本数、未含 holdout 校验字段）。

### Phase 2: 换可判别的前置 gate

1. 设计新的"疑似脸场景 vs 普通图"前置判定，替换 v15 的 `maxFacePresence>=0.08` 敞开阈值——目标是触发率明显低于 99.6% 且能真正区分场景。
2. 在全量 7692 上刻画新 gate 的触发率 + 抽样准确率，与 v15 的 99.6% 对比。
3. 输出 `output/semantic-false-face-diagnosis/v15b/upstream-gate-v2-coverage.json`。

### Phase 3: 84 holdout 评估

1. crop 判别器（+ 新 gate）在同一 84 holdout 上跑分。
2. 同口径报 v12/v13/v14/v15/v15B 可比 AUC / TPR@0.5 / FPR@0.5、正样本 vs 对照分布。
3. 达标线：AUC ≥ 0.75（不低于 v15），**FPR 明显 <36.7%（目标 <15%）**，TPR@0.5 非零，正样本组 > 对照组。

### Phase 4: 全量 replay + 判定

1. 全量 7692 跑剔除/降权/baseline 三组 replay，报 recall@38/45/50/60 + negative pick rate，同 rankMode。
2. @45 回退是否 <2pp 的明确判定。
3. 误伤 top 列表 + scene 分布，对比 v15A 的误伤集中区。
4. `output/semantic-false-face-diagnosis/v15b/false-face-v15b-report.md`：
   - 84 holdout 五代可比表 + FPR 是否压下来
   - 新 gate 全量触发率 vs v15 的 99.6%
   - 三组 replay recall + @45 回退判定
   - 诚实结论：路线 B 是否够格进自动拦截（剔除/降权哪种可行，或仍 guard-only）；不达标则说明还差什么、代价多大

## 验收标准

- [ ] crop 训练集正负样本数 + scene 分布已报，photoId ∩ 84 holdout = 0 已校验
- [ ] 独立 crop 判别器训练完成，与 semantic student 解耦，未动 backbone/teacher prompt
- [ ] 新前置 gate 全量触发率 + 抽样准确率，与 v15 的 99.6% 对比
- [ ] 84 holdout 同口径报 v12/v13/v14/v15/v15B 可比 AUC/TPR/FPR
- [ ] FPR 是否明显 <36.7%（目标 <15%）有明确数字
- [ ] 全量 7692 三组 replay，@45 回退是否 <2pp 有明确判定
- [ ] 84 holdout 未进训练/调参/阈值拟合
- [ ] 诚实结论：路线 B 能否进自动拦截；不达标给差距 + 代价

## 输出文件

```
output/semantic-false-face-diagnosis/v15b/
  crop-dataset-manifest.json          # 训练 crop 正负样本 + 零重叠校验
  training-report-v15b.json           # 判别器训练 + holdout 留出校验
  upstream-gate-v2-coverage.json      # 新前置 gate 全量触发率 vs 99.6%
  v15b-holdout-scores.csv             # 84 holdout 分数
  false-face-v15b-report.md           # 五代可比 + FPR + replay + 自动拦截判定
```
