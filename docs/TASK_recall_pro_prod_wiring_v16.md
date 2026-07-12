# Task: 召回线 Pro persona 排序生产接线 + 保真校验 + 内部验证（整晚批量）

## 背景与现状（必读）

召回线已在实验室充分验证、因果拆分做干净（2026-07-01）：v14 semantic student 模型自身净增量 **+21.52pp**（@45，Current 38.90% → v14+Flash persona 60.42%，同 persona vs 规则），v14 Pro semantic @45 = 63.18%，仍低于 legacy Pro persona v1（64.14%）0.96pp 未反超。结论：**可进 Pro 灰度实验候选，但不替换 legacy，Flash 默认不动。**

**但这套验证只活在 lab：**
- 生产已有 `src-tauri/src/pro_infer/`（Rust，`#[cfg(feature = "pro")]` 门控）跑蒸馏多头 ONNX student，出原始多头分数（`pro_infer_init` / `pro_infer_batch`）。
- **生产没有 persona 排序逻辑**——把 student 分数变成"按 Pro persona 在 38/45/50/60% 工作点挑片"的那套（lab 验证出 +21.52pp 的核心）只在 `tools/ai-lab/bench-pro-persona.mjs`。
- rollout-plan 引用的 `proPersonaRanking.enabled` 开关**不存在**。
- 假脸线已封存为 guard-only，**本轮完全不碰假脸**。

## 目标

把 lab 验证过的 Pro persona 排序逻辑**忠实搬到生产**，挂在独立、默认 off 的开关后，接到 `pro_infer` 输出上；用"生产 vs lab 同集同分一致性校验"钉死保真；然后跑 rollout-plan 第一阶段内部验证，确认 app 里能复现 lab 数字。整夜批量跑足够规模的内部图集。

## 不可动的硬约束（先读）

- **保真优先（本轮第一红线）**：生产排序结果必须与 lab `bench-pro-persona.mjs` 在**同一图集、同一 student 分数**输入下一致。一致性目标：同工作点（38/45/50/60）选中集合完全一致（Jaccard=1.0），或差异有可解释来源并 < 0.5%。**任何不可解释的偏差是 bug，必须定位修复，不许调参凑近、不许用"差不多"蒙混。**
- **Flash/default 绝对不动**：不加载 Pro persona、不改缓存 schema、不改用户默认体验。`proPersonaRanking.enabled` 默认 `false`。Flash build 不得编译 pro 代码（沿用 `#[cfg(feature="pro")]` 门控）。
- **不重训、不动模型/teacher prompt/backbone**。本轮纯生产工程接线 + replay 验证，不产生新模型版本。
- **不碰假脸线**（已封存 guard-only）。不把假脸作为本轮门槛或卖点。
- **legacy Pro persona v1 不被替换**：新路线是独立开关并行，不顶替现有排名。
- **诚实优先**：生产复现不了 lab 数字就如实写差多少、差在哪；一键回退必须真实可用并实测。

## 实现步骤

### Phase 0: 摸清 lab persona 排序的"真值定义"

1. 通读 `tools/ai-lab/bench-pro-persona.mjs`（及其依赖），把 persona 排序逻辑拆成可移植规格：输入（哪些 student 头/分数）、persona 加权/打分公式、gateMode（hard-only）、groupMode（known / pair-threshold 0.92）、相似度去重、各比例工作点选片规则、negative pick 统计口径。
2. 输出 `output/recall-productize/v16-prod-wiring/persona-ranking-spec.md`：逐条写清，作为生产实现的唯一规格来源。标注任何 lab 里隐含的默认值/边界处理。

### Phase 1: 生产侧 Pro persona 排序实现（独立开关，默认 off）

1. 在生产代码实现 persona 排序：消费 `pro_infer_batch` 的多头输出 → 按 Phase 0 规格算 persona 分 → 按工作点排序挑片。位置与语言按现有架构定（Rust 侧 or 前端编排，沿用 pro feature 门控）。
2. 新增 `proPersonaRanking.enabled` 开关，默认 `false`；off 时完全走现有路径，零副作用。
3. 不改缓存 schema；Pro 分数若缓存，单独命名空间，回退时不参与排序。
4. Rust 改动配套单元测试；前端编排改动配套测试。

### Phase 2: 生产 vs lab 保真校验（本轮核心验收）

1. 取一组固定图集，先用 lab `bench-pro-persona.mjs` 跑出 38/45/50/60 选中集合（baseline 真值）。
2. 用**完全相同的 student 分数**喂生产排序路径，跑出生产选中集合。
3. 逐工作点比对：选中集合 Jaccard、对称差样本列表、recall/negative pick rate 是否一致。
4. 输出 `output/recall-productize/v16-prod-wiring/fidelity-check.json` + `fidelity-report.md`：
   - 每个工作点 Jaccard、不一致样本 + 归因
   - **判定：是否达成保真（Jaccard=1.0 或差异可解释且<0.5%）**
   - 若不达标：定位根因（公式/排序稳定性/浮点/边界）、修复、复跑，直到达标或如实记录无法消除的差异来源

### Phase 3: 构建 + 全测试

1. 跑 pro feature 的构建（确认 pro build 编译通过、Flash build 不含 pro 代码）。
2. 跑 Rust 单测 + 集成测试 + 前端测试，全绿。失败先修再继续。
3. 记录构建/测试命令与结果到报告。

### Phase 4: rollout-plan 第一阶段内部验证（整夜批量）

1. 在我们自己的图集（G 盘 / 相机 / 五台山 / 新增户外集，尽量大规模，整夜跑）开 `proPersonaRanking.enabled=true` 跑生产排序。
2. 报 45%/50% 工作点（主）+ 38%/60%（辅）：recall 代理、negative pick rate、重复污染（正式重复组多选、相邻高相似多选）、推理错误率、单图耗时、批失败率。
3. 与 lab v14 Pro persona 对应数字对比，确认 app 复现。
4. 反馈标签分层统计（大景/空镜、人像、合照、活动纪实），不混成单一平均。
5. 输出 `output/recall-productize/v16-prod-wiring/internal-validation-report.md`。

### Phase 5: 一键回退实测 + 监控埋点

1. 实现并**实测**一键回退：关 `proPersonaRanking.enabled` → 立即回现有规则、Pro 缓存分不参与排序、无需迁移用户项目。记录实测步骤与结果。
2. 落 rollout-plan 列的监控指标埋点（手动恢复率、弃用率、重复污染、稳定性、分层反馈），或如实说明哪些埋点需后续接入。
3. 输出 `output/recall-productize/v16-prod-wiring/rollback-and-monitoring.md`。

### Phase 6: 汇总报告

`output/recall-productize/v16-prod-wiring/v16-summary.md`：
- 保真校验结论（生产是否=lab，差异归因）
- 构建/测试结果
- 内部验证：app 是否复现 lab 的 @45 64.14% / @50 等，差多少
- 回退实测结果
- 诚实判定：召回 Pro 路线是否可进 rollout-plan 第二阶段（5% Pro 内测）；不可则差什么
- 重申边界：legacy 不替换、Flash 不动、假脸不绑

## 验收标准

- [ ] persona 排序规格 Phase 0 成文，作为生产实现唯一来源
- [ ] 生产 Pro persona 排序实现完成，`proPersonaRanking.enabled` 默认 off，off 时零副作用
- [ ] Flash build 不编译 pro 代码（门控保持），缓存 schema 未改
- [ ] **保真校验：38/45/50/60 选中集合 Jaccard=1.0 或差异可解释且<0.5%，不达标已定位修复或如实记录**
- [ ] pro build 编译通过；Rust + 前端测试全绿
- [ ] 内部验证：自有大图集 45/50/38/60 全指标 + 与 lab 对比，分层统计
- [ ] 一键回退已实现并实测，记录步骤结果
- [ ] 监控埋点落地或如实标注待接入项
- [ ] 诚实判定能否进 5% Pro 内测；legacy 不替换 / Flash 不动 / 假脸不碰均保持

## 输出文件

```
output/recall-productize/v16-prod-wiring/
  persona-ranking-spec.md          # lab 排序逻辑可移植规格（真值来源）
  fidelity-check.json              # 生产 vs lab 逐工作点比对
  fidelity-report.md               # 保真判定 + 不一致归因
  internal-validation-report.md    # 自有大图集内部验证 + 与 lab 对比 + 分层
  rollback-and-monitoring.md       # 一键回退实测 + 监控埋点
  v16-summary.md                   # 汇总 + 能否进 5% 内测判定
```
