# Task: 假脸独立头泛化验证 + 必要时扩 hard-negative 重训（v13）

## 背景

v12 改用独立 `falseFaceRisk` 头是**正确方向**（已证实 `1 - faceValidity` 是坏派生量：70% 标注不一致、v11 srcc −0.65 → v12 +0.67）。但 v12 **未闭环**，二次审计确认两个硬伤：

1. **补证集没提供独立证据**：`false-face-positive-validation-v12.md` 的两个"强正样本"正是 `training-report-v12.json` 里仅有的 2 个 hard-negative。`DSC08858`（train 集）v12 命中 0.91，`DSC08173`（val 集）v12 漏判 0.002——命中的是训练见过的、漏判的是留出的。等于拿训练样本验证自己。
2. **训练 hard-negative 近乎为零**：全量 6475 张里符合 hard-negative（hasRealHumanFace=false 且 risk≥0.5）只有 2 张，train 仅 1 张。独立头几乎没有正样本可学，极可能只是"贴低先验"。

## 目标

回答一个问题：**v12 独立头是真能判别假脸，还是只是贴低先验？** 用一个与训练完全不重叠的独立验证集给出硬证据；若 v12 泛化失败，则扩充训练 hard-negative 后重训 v13 并复测。

## 关键约束（先读）

- **独立验证集必须与训练数据零重叠**。绝不能再用训练里那 2 张 hard-negative（DSC08858 / DSC08173）或任何进过 train/val split 的样本。跑前用 photoId 集合做交集校验，交集必须为 0 并在报告里写明。
- **口径与 v12 一致**：用 v12 独立头导出的 `falseFaceRisk`，不要回退到 `1-faceValidity`。
- **不许拿训练样本、合成样本或 teacher 自标当独立 ground truth**。独立集的标签必须人工确认。
- 诚实优先于好看。泛化失败就如实写"独立头未泛化"，不要用训练集表现掩盖。

## 实现步骤

### Phase 1: 造独立真假脸验证集（不重训）

1. 从**未进入 6475 训练全集**的图源里，人工挑选 30~60 张"真·假脸"正样本——即 hasRealHumanFace 应为 false、但视觉上容易被幻视成人脸的图，覆盖 landscape / product_object / empty_scene / event / food（v11 里风险最高的几类）。
   - 来源可以是 camera/audit3groups 里没被采进训练的剩余图，或新拍/新收的图。
   - 每张人工标注 `hasRealHumanFace=false` 并记录 photoId、scene、为何容易幻视（岩石/树纹/云/产品轮廓/灯具等）。
2. 同时挑 20~30 张**真·有脸**的对照正样本（hasRealHumanFace=true），用来确认独立头不是把所有图都判高 risk（避免反向退化）。
3. 用 photoId 与 `training-report-v12.json` 的 train+val 全集做交集校验，**交集=0**，写进报告。

### Phase 2: 测 v12 独立头泛化（不重训）

1. 对独立集跑 v12 独立头，记录每张的 `falseFaceRisk`。
2. 报告：
   - 真假脸正样本上 risk 的分布（中位数 / 均值 / ≥0.5 命中率）
   - 真有脸对照样本上 risk 的分布（应当低）
   - 两组能否分开（简单阈值下的 TPR/FPR 或 AUC）
3. 判定：
   - 若真假脸正样本 risk **显著高于**对照且命中率可观（如 ≥60% ≥0.5）→ 独立头有泛化判别力，**可初步判闭环**。
   - 若真假脸正样本 risk 仍普遍偏低（贴近全局先验 0.07）→ **未泛化**，进入 Phase 3。

### Phase 3: 仅在 Phase 2 失败时——扩 hard-negative 重训 v13

1. 把 Phase 1 挑出的真假脸正样本**之外**的、来自训练图源的更多 hard-negative 补进训练集（提高 hard-negative 数量级，从 2 张提到至少几十~上百张），重新构造训练 jsonl。
   - **注意**：Phase 1 的独立验证集这些 photoId **不得**进训练，保持留出。
2. 仅重训 student（backbone/teacher prompt 不动），新版本 v13。
3. 重跑 Phase 2 的独立集评估，对比 v12 vs v13。

### Phase 4: 报告

写 `output/semantic-false-face-diagnosis/v13-eval/false-face-generalization-report.md`：
- 独立集构造说明 + 零重叠校验结果
- v12（及 v13 若有）在独立集上的 risk 分布、命中率、正负组可分性
- 明确判定：**独立头是否真有泛化判别力 / 是否闭环**
- 若重训了 v13：召回 trade-off 复测（@45% 回退 < 2pp）
- 诚实标注仍漏判的场景

## 验收标准

- [ ] 独立真假脸验证集（30~60 正 + 20~30 对照）已建，人工标注
- [ ] photoId 与训练 train+val 全集交集 = 0，已校验并写明
- [ ] v12 独立头在独立集上的 risk 分布 + 正负组可分性已报告
- [ ] 明确判定 v12 是否泛化（真判别 vs 贴先验）
- [ ] 若 Phase 2 失败：v13 扩 hard-negative 重训完成，独立集复测，v12 vs v13 对比
- [ ] 报告给出闭环/未闭环诚实判定，召回 trade-off（若重训）已复测

## 输出文件

```
output/semantic-false-face-diagnosis/v13-eval/
  independent-false-face-set.csv          # 独立验证集 photoId/scene/标签/幻视原因
  overlap-check.json                       # 与训练全集交集校验（必须=0）
  v12-generalization-scores.csv            # v12 独立头在独立集上的 risk
  v13-generalization-scores.csv            # 若重训
  false-face-generalization-report.md      # 泛化判定 + 闭环结论
  training-report-v13.json                 # 若重训：含 SHA 校验、新 hard-negative 数
```
