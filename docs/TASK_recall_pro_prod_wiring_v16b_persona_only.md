# Task: 召回线 Pro 生产 profile 换变体（flash-persona → persona-only）+ 重跑保真 + 内部验证

## 背景与现状（必读）

v16 已把 lab persona 排序忠实接入生产（`src/utils/proPersonaRanking.ts`，开关 `proPersonaRanking.enabled` 默认 off），全量 7692 同集同分 replay 在 38/45/50/60 四工作点 Jaccard=1.0、diff 0.000%，保真红线通过。构建/测试全绿、Flash bundle 无 Pro 标记、一键回退实测过。

**但当前生产化的 rank profile 是 `pro-semantic-v2-flash-persona`（@45 recall = 60.42%）**，这是 v15 因果拆分里"干净模型信号"的 Flash-persona 变体。经与用户确认后决定**换成 `pro-semantic-v2-persona-only`（@45 recall = 63.18%）** 作为上线候选——它是 v14 student 自己的 persona-only 排序，比 flash-persona 高约 2.76pp，更接近 legacy Pro persona v1（64.14%）的天花板（仍差 0.96pp、未反超）。

已核对（审计结论，作为实现前提，实现时请自行复核）：
- 生产 `proPersonaRankScore` 已内置 `pro-semantic-v2-persona-only` 分支（`src/utils/proPersonaRanking.ts` 约 165-167 行），公式 `overall*0.54 + technical*0.28 + scene*0.24 + nativeAesthetic*0.14 + persona*46 + focusReliability*4.5 - reviewPenalty`。
- lab `tools/ai-lab/tune-ai-picks-supervised.mjs` 的 `pro-semantic-v2-persona-only` 分支（约 1086-1089 行）公式逐系数相同，且**无** `pro-persona` 分支那种 `personaBonus` 中间项。
- 两变体的 ratio 分组配置一致：0.38/0.45 = `known`，0.50/0.60 = `pair-threshold` sim 0.92、maxNumericGap 12、maxTimeGap 8min。
- 因此换变体理论上应保持 Jaccard=1.0；但**这是必须实测证明的，不是可假设的**。

## 目标

把生产 Pro persona 排序的默认 rank profile 从 `pro-semantic-v2-flash-persona` 切到 `pro-semantic-v2-persona-only`，重跑全量保真校验钉死一致性，重跑 build/全测试，重跑整夜内部验证确认 app 复现 lab 的 63.18%（@45）；更新所有受影响的报告与 spec。开关语义、边界、回退一律不变。

## 不可动的硬约束（先读）

- **保真优先（第一红线）**：切到 persona-only 后，生产排序结果必须与 lab `bench-pro-persona.mjs` / `tune-ai-picks-supervised.mjs` 在**同一图集、同一 student 分数、persona-only rankMode** 下一致。目标：38/45/50/60 选中集合 Jaccard=1.0，或差异有可解释来源且 <0.5%。**任何不可解释偏差是 bug，必须定位修复，不许调参凑近。** 若切换后 Jaccard 掉了，先查公式/分组/排序稳定性/浮点/默认 rankMode 传参，而不是接受偏差。
- **Flash/default 绝对不动**：Flash 路由继续无视 `proPersonaRanking.enabled`，不加载 Pro persona、不改缓存 schema。开关默认仍 `false`，off 时零副作用走旧 `buildAiPickedPhotoIds`。
- **不重训、不动模型/teacher prompt/backbone**。纯 profile 切换 + replay 验证，不产生新模型版本。student 分数复用现有 `pro_infer_batch` 输出。
- **不碰假脸线**（已封存 guard-only）。
- **legacy Pro persona v1（`pro-persona` rankMode，64.14%）不被替换**：persona-only 仍是独立开关后的实验候选，并行存在、不顶替 legacy。
- **不删除 flash-persona 变体**：保留 `pro-semantic-v2-flash-persona` rankMode 及其代码路径（供 A/B 与归因回溯），仅改"生产默认选用哪个"。
- **诚实优先**：persona-only 在 app 复现不了 63.18% 就如实写差多少、差在哪；一键回退必须仍真实可用并实测。

## 实现步骤

### Phase 0: 切换前基线确认
1. 复核上面"已核对"三条（生产/lab persona-only 公式逐系数一致、无 personaBonus、分组配置一致）。若发现任何不一致，**停下先报**，不要擅自改公式凑。
2. 记录切换前 flash-persona 的保真与指标现状（引用现有 `fidelity-report.md`），作为对照。

### Phase 1: 生产侧 profile 切换
1. `src/utils/proPersonaRanking.ts`：把 `PRO_PERSONA_SELECTED_RATIO_PROFILES` 四个条目的 `rankMode` 从 `pro-semantic-v2-flash-persona` 改为 `pro-semantic-v2-persona-only`；`profileForRatio` 的默认、`proPersonaRankScore` 的默认参数、`PRO_PERSONA_RANKING_VERSION` 串同步更新（如 `pro-persona-ranking-v16b-persona-only`）。ratio/gate/group/similarity 等其余字段不动。
2. `proPersonaRankScore` 的 persona-only 分支公式保持不变（已就位）。不要动 flash-persona 分支。
3. 缓存 schema 不改；Pro 分单独命名空间不变。
4. 配套单测更新：断言默认 rankMode = persona-only、断言 persona-only 打分公式、保留 flash-persona 打分的既有测试。

### Phase 2: 生产 vs lab 保真校验（核心验收）
1. 用 lab persona-only 跑固定图集（全量 7692，`inputs/ai-culling-bench-pro-semantic-full-7692.json`）出 38/45/50/60 baseline 真值。
2. 用**完全相同的 student 分数**喂切换后的生产路径，出生产选中集合。
3. 逐工作点比对 Jaccard、对称差样本、recall/negative pick。
4. 输出到 `output/recall-productize/v16b-persona-only/`：`fidelity-check.json` + `fidelity-report.md`，每工作点 Jaccard + 不一致归因 + 判定。不达标先定位修复再复跑。

### Phase 3: 构建 + 全测试
1. Pro feature build（编译过、Flash build 不含 Pro persona 标记）；Flash build。
2. Rust 单测/集成 + 前端 vitest 全绿。失败先修。
3. 命令与结果记入报告。

### Phase 4: 内部验证（整夜批量）
1. 自有图集（G 盘 / 相机 / 五台山 / 户外集，尽量大规模）开 `proPersonaRanking.enabled=true` 跑 persona-only 生产排序。
2. 报 45/50（主）+ 38/60（辅）：recall 代理、negative pick rate、重复污染（正式重复组多选、相邻高相似多选）、推理错误率、单图耗时、批失败率。
3. 与 lab v14 persona-only 对应数字对比（@45 目标复现 63.18%），确认 app 复现，差多少如实写。
4. 反馈标签分层（大景/空镜、人像、合照、活动纪实），不混单一平均。
5. 输出 `output/recall-productize/v16b-persona-only/internal-validation-report.md`。

### Phase 5: 回退实测 + spec/报告更新
1. 实测一键回退：关 `proPersonaRanking.enabled` → 回旧规则、Pro 缓存分不参与、无需迁移。记录步骤结果。
2. 更新 `output/recall-productize/v16-prod-wiring/persona-ranking-spec.md`（或新建 v16b spec）：把生产候选 profile 标为 persona-only、更新公式块与 ratio 表、注明 flash-persona 保留为对照。
3. 输出 `output/recall-productize/v16b-persona-only/rollback-and-monitoring.md`。

### Phase 6: 汇总报告
`output/recall-productize/v16b-persona-only/v16b-summary.md`：
- 切换内容（flash-persona → persona-only，改了哪些行）
- 保真结论（切换后是否仍 Jaccard=1.0，差异归因）
- 构建/测试结果
- 内部验证：app 是否复现 lab @45 63.18%，差多少
- 回退实测结果
- 诚实判定：persona-only 作为 5% Pro 内测候选是否 ready；重申 legacy(64.14%) 未被反超（仍差 0.96pp）、不替换、Flash 不动、假脸不绑

## 验收标准

- [ ] 生产四 ratio profile + 默认 rankMode + version 串切到 persona-only；flash-persona 分支保留
- [ ] persona-only 公式与 lab 逐系数一致（已核，实现时复核无出入）
- [ ] **保真：38/45/50/60 Jaccard=1.0 或差异可解释且<0.5%，不达标已定位修复或如实记录**
- [ ] Flash build 不含 Pro persona 标记、缓存 schema 未改、开关默认 off、off 零副作用
- [ ] Pro build 编译过；Rust + 前端测试全绿
- [ ] 内部验证：自有大图集 45/50/38/60 全指标 + 与 lab persona-only 对比（@45 vs 63.18%）+ 分层
- [ ] 一键回退实现并实测，记录步骤结果
- [ ] spec/报告更新，生产候选标为 persona-only、flash-persona 留作对照
- [ ] 诚实判定能否进 5% Pro 内测；legacy 不替换 / Flash 不动 / 假脸不碰保持

## 输出文件

```
output/recall-productize/v16b-persona-only/
  fidelity-check.json              # 切换后生产 vs lab persona-only 逐工作点比对
  fidelity-report.md               # 保真判定 + 归因
  internal-validation-report.md    # 自有大图集内部验证 + 与 lab 63.18% 对比 + 分层
  rollback-and-monitoring.md       # 一键回退实测 + 监控埋点
  v16b-summary.md                  # 汇总 + 能否进 5% 内测判定
# 并更新 output/recall-productize/v16-prod-wiring/persona-ranking-spec.md（或新建 v16b spec）
```
