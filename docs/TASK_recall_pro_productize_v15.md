# Task: 召回线产品化（Pro 实验候选，不动 Flash 默认）

## 背景

v14 双线里，**召回线是真在涨、可以推进产品化**；假脸线另案（见 TASK_false_face_decouple）。但 v14 的召回大数有混淆，必须先把"真增量"和"配置差"拆开，再决定怎么上线。

已知事实（来自 v14 报告 recall-report-v14.md，服务器 /data/FrameCullModelLab/outputs/semantic-false-face-diagnosis/v14/）：
- v14 Pro persona vs 当前生产规则：@38 30.33→55.33、@45 38.90→64.14、@50 44.35→68.91、@60 62.42→78.49。
- **但这组大数是"模型 vs 规则 + Pro persona vs Flash persona"混合，不是 v14 本轮的纯增量。**
- 同 persona 下 v12/v13/v14 @45 = 55.73→62.57→**64.14**，v14 比 v13 仅 +1.57pp（温和）。

## 目标

把召回线做成一个**可信、可复现、可上线开关**的 Pro 实验候选：诚实拆分增量来源，给出在生产可观测口径下的真实收益，并定义灰度/回退方案。**不改 Flash 默认行为。**

## 不可动的硬约束（先读）

- **诚实拆分，不许用混合大数当卖点**：报告必须把 (a) 模型 vs 规则、(b) Pro persona vs Flash persona、(c) v14 vs v13 同 persona 三个增量分开列，并标明每个数字是哪种对比。上线收益评估只能引用"同口径可归因"的那部分。
- **不动 Flash 默认**：Pro 走独立 persona/开关，默认仍是当前生产规则或 Flash，灰度可控、可一键回退。
- **不动 backbone、teacher prompt、不重标注**；merged teacher 跑前校验 SHA（8929 条，SHA256 `6c64805b...a0efd00`，跑前打印完整 64 位核对）。
- **84 张独立 holdout 永不进训练/调参**（output/semantic-false-face-diagnosis/v13-eval/independent-false-face-set.csv）。
- 召回评估口径固定：recall@38/45/50/60 + negative pick rate，与 v12/v13/v14 完全可比，不许换口径。

## 实现步骤

### Phase 0: 增量归因拆分（只算，不重训）

1. 在同一 eval 全集上，固定其余变量，分别测：
   - **模型 vs 规则**：同 persona（如都 Pro 或都 Flash）下，student v14 vs 当前生产规则。
   - **persona 差**：同模型（v14）下，Pro persona vs Flash persona。
   - **版本差**：同 persona 下，v14 vs v13 vs v12。
2. 输出 `output/recall-productize/v15/recall-attribution.json`，每个 @比例都标三种增量的分解，明确哪部分可归因到"模型本身"。
3. **决策点**：若"模型本身（同 persona、vs 规则）"的净增量不足以支撑上线（例如 @45 同 persona vs 规则 < 几个 pp），如实写明，召回产品化降级为"继续观察"，不强行包装。

### Phase 1: 生产可观测口径对齐

1. 确认线上实际用的筛选比例与判定阈值，把 eval 的 @比例映射到生产真实工作点。
2. 在该工作点报告：真实召回、负样本误选率（negative pick rate）、对用户可感知的影响（少漏多少张该留的、多挑多少张该弃的）。
3. 输出 `output/recall-productize/v15/production-operating-point.md`。

### Phase 2: Pro 开关 / 灰度方案

1. 设计 Pro persona 作为独立可开关路径：默认 off，Flash/规则不受影响。
2. 定义灰度策略（按比例放量）、监控指标、回退触发条件（如 negative pick rate 超阈值自动回退）。
3. 不需要真的全量上线，产出可执行的开关 + 灰度设计文档 `output/recall-productize/v15/rollout-plan.md`，含一键回退说明。

### Phase 3: 验证 + 报告

1. 复跑 Phase 0 关键对比，确保数字可复现（同 SHA、同 eval 集）。
2. `output/recall-productize/v15/recall-report-v15.md`：
   - 三种增量分解表 + 可归因到模型的净收益
   - 生产工作点真实收益
   - Pro 开关/灰度/回退方案摘要
   - 诚实结论：召回是否够格上 Pro 实验、预期收益区间、风险

## 验收标准

- [ ] 增量三拆分完成（模型vs规则 / Pro vs Flash persona / v14 vs v13/v12 同 persona），每个数字标明对比类型
- [ ] merged teacher SHA 校验通过（8929 / 6c64805b...a0efd00）
- [ ] 生产工作点真实召回 + negative pick rate 已报告
- [ ] Pro 独立开关 + 灰度 + 一键回退方案产出，Flash 默认不变
- [ ] 报告给出"是否够格上 Pro 实验"的诚实判定，不用混合大数包装收益
- [ ] 84 holdout 未进训练/调参

## 输出文件

```
output/recall-productize/v15/
  recall-attribution.json         # 增量三拆分
  production-operating-point.md    # 生产工作点收益
  rollout-plan.md                  # Pro 开关 + 灰度 + 回退
  recall-report-v15.md             # 汇总 + 诚实判定
```
