# Task: 召回线补"同模型 Flash persona"消融——拆出 v14 模型自身净增量

## 背景与现状（必读）

v15 召回收口已诚实承认一个缺口：报告里 `Pro persona v1 - semantic persona-only` 只是**可观察实现差异**，不是同模型因果拆分。因为源指标没有"**同一 v14 模型 + Flash persona rankMode**"这一行，所以现在**算不出纯的 Pro persona vs Flash persona 缺口**，也就不能声明"v14 模型自身贡献"。

这是 v14 student 是否够格替换 legacy Pro persona v1 的关键证据缺口。

## 目标

补齐"同 v14 模型 + Flash persona"那一行，在同一 eval scope 下做到三因素彻底可分：(a) 模型 vs 规则、(b) persona Pro vs Flash（同模型）、(c) 版本 v14 vs v13。给出 v14 模型自身净增量的诚实数字，据此判定 v14 student 是否够格进 Pro 排名或替换 legacy persona。

## 不可动的硬约束（先读）

- **同 eval scope、同口径**：与 v15 recall-report 完全一致的 7692/全量集、recall@38/45/50/60 + negative pick rate，新增行才可比。
- **不重训、不改 teacher prompt**：仅新增"v14 模型 + Flash persona rankMode"这一组 replay 配置后重跑，merged teacher 跑前校验 SHA（8929 / 6c64805b…a0efd00）。
- **84 holdout 不进训练/调参**。
- **诚实优先**：拆出的"模型自身净增量"若很小，如实写；不许把 persona 差或规则差算进模型功劳。Flash 默认不动的结论不受本轮影响。

## 实现步骤

### Phase 0: 跑缺失的那一行

1. 配置"v14 semantic student + Flash persona rankMode"，在同一 eval scope 跑 recall@38/45/50/60 + negative pick rate。
2. 与现有三行（current 规则 / v14 semantic persona-only / legacy Pro persona v1）并表。

### Phase 1: 三因素拆分

1. **persona 差（同 v14 模型）**：Pro persona vs Flash persona，各 @比例。
2. **模型差（同 persona）**：v14 student vs 规则。
3. **版本差（同 rankMode）**：v14 vs v13。
4. 每个数字标明属于哪种对比，输出 `output/recall-productize/v15/recall-attribution-v2.json`（在原 attribution 上补全 Flash persona 行）。

### Phase 2: 判定 + 报告

1. 更新/追加 `output/recall-productize/v15/recall-report-v15.md`（或新建 v15b）：
   - 补全后的四行对照表 + 三因素拆分
   - v14 模型自身净增量的诚实数字
   - 判定：v14 student 是否够格进 Pro 排名 / 替换 legacy Pro persona v1
   - 维持"Flash 默认不动、Pro 独立开关默认 off"的产品结论

## 验收标准

- [ ] "v14 模型 + Flash persona" 行已跑，同 eval scope、同口径，四行可比
- [ ] persona/模型/版本三因素分别拆出，每个数字标对比类型
- [ ] v14 模型自身净增量给出诚实数字
- [ ] merged teacher SHA 校验通过；84 holdout 未进训练/调参
- [ ] 明确判定 v14 student 是否够格进 Pro 排名/替换 legacy persona
- [ ] Flash 默认不动结论保留

## 输出文件

```
output/recall-productize/v15/
  recall-attribution-v2.json      # 补全 Flash persona 行的三因素拆分
  recall-report-v15.md（更新）     # 模型自身净增量 + v14 是否够格替换判定
```
