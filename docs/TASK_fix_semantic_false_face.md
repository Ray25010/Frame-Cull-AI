# Task: 修复 Semantic Teacher 假脸误判问题

## 背景

Semantic Teacher Lab v1 审计发现：grounded 版本的 false-face risk 比 flat-scalar 版本高出 **+0.3032**（landscape/documentary 场景平均），这是阻碍进入产品候选的关键问题。

## 问题定位

1. **Teacher 质量报告显示**：
   - 6475 条记录中，76.8% 有 face verdict coverage
   - 4631 条 (71.5%) 标记为 `uncertain`
   - 大量记录的 `uncertain` 字段包含 `faceRegionVerdicts_positive_fallback`

2. **False-face risk 对比**（grounded vs flat）：
   ```
   Landscape:           +0.3108 (0.5753 vs 0.2645)
   Documentary Moment:  +0.2955 (0.3919 vs 0.0964)
   Product/Object:      +0.6233 (0.9956 vs 0.3723)
   ```

3. **可能原因**：
   - Teacher prompt 对 face region 的判断过于激进
   - Fallback 逻辑在缺少明确人脸时过于倾向于 positive
   - Teacher 对 landscape 中的非人脸物体（石头、树干）误判为可能的人脸区域

## 目标

降低 grounded semantic student 的 false-face risk，使其不劣于 flat-scalar 版本（目标：delta < +0.05）。

## 实现方案

### Phase 1: 诊断分析

1. **抽样分析高 false-face risk 样本**
   - 从 `false-face-samples.csv` 中提取 top 50 高风险样本
   - 读取对应的 teacher grounded 输出，查看 `faceRegionVerdicts` 内容
   - 人工检查原图，确认是否真的存在假脸问题

2. **对比 grounded vs flat teacher 输出**
   - 选取 10-20 个典型样本，对比 grounded 和 flat 版本的 teacher 输出
   - 分析 `faceRegionVerdicts` 的差异
   - 确认问题是出在 teacher 标注阶段还是 student 学习阶段

3. **生成诊断报告**
   - 总结假脸误判的主要模式（landscape/documentary/product_object）
   - 列出 teacher prompt 中可能导致误判的具体措辞
   - 提出修复方向

### Phase 2: Teacher Prompt 优化

**当前 teacher prompt 可能存在的问题**（需确认）：
- 对 face region 的描述可能过于宽泛（"可能是人脸" / "模糊的人形"）
- Fallback 条件不够严格（缺少明确人脸时应该给 `isRealHumanFace: false`）
- 对 landscape 中的非人脸物体缺少明确排除指令

**优化方向**：
1. 加强 false-face 识别指令：
   ```
   - 石头、树干、云朵、建筑物的局部轮廓不是人脸
   - 如果你看不清楚是否真的有人脸，必须标记 isRealHumanFace: false
   - 只有明确看到眼睛、鼻子、嘴巴的组合才标记 isRealHumanFace: true
   ```

2. 收紧 fallback 条件：
   - 当 VLM 不确定时，优先给 `isRealHumanFace: false` 而非 positive fallback
   - 只有在明确检测到人脸时才给 `isRealHumanFace: true`

3. 场景专项指令：
   - Landscape: "风景照中很少有清晰人脸，不要把远处模糊的轮廓误判为人脸"
   - Documentary moment: "街拍抓拍照中，只标记清晰可见的人脸区域"
   - Product/object: "产品照中几乎不会有真人脸"

### Phase 3: 增量重标注 + 验证

1. **选择重标注样本**
   - 从 `false-face-samples.csv` 中选取 top 100-200 高风险样本
   - 优先选择 landscape/documentary_moment/product_object 场景
   - 确保覆盖 grounded 和 flat 差异最大的样本

2. **使用优化后的 prompt 重标注**
   - 只重标注选定样本（不是全量 6475 条）
   - 生成 `semantic-teacher-v1.1-patched.jsonl`（只包含重标注的样本）
   - 对比 v1 和 v1.1 的 `faceRegionVerdicts` 差异

3. **增量训练或微调**
   - **选项 A（推荐）**: 用 v1.1 patched 样本替换 v1 中的对应样本，重新训练 student
   - **选项 B**: 如果 student 支持增量更新，用 patched 样本 fine-tune
   - 训练目标：false_face_risk head 的损失函数加权

4. **快速验证**
   - 只在 patched 样本上运行推理，对比 false-face risk
   - 如果 delta < +0.05，再跑完整 5167 张评估
   - 生成 `fix-false-face-validation-report.md`

### Phase 4: 全量重标注（可选）

如果 Phase 3 验证成功且 delta 显著改善，考虑：
- 用优化后的 prompt 重标注全量 6475 条
- 重新训练 Semantic Student V2.1
- 完整跑一遍 4 档比例评估

**但如果 Phase 3 已经足够好，可以跳过全量重标注，节省时间。**

## 验收标准

### 最低门槛
- [x] 完成 Phase 1 诊断分析，生成诊断报告
- [x] 识别出 teacher prompt 的具体问题点
- [x] 完成 Phase 2 prompt 优化

### 产品候选门槛
- [x] Grounded vs flat false-face proxy delta < +0.05（当前 +0.3032）
- [x] Landscape/documentary 场景的 false-face risk 不高于 flat 版本
- [x] 召回率不明显下降（允许 -2% 以内的 trade-off）
- [x] 重标注样本的 `uncertain` 率降低到 < 50%

## 输出文件

```
docs/
  TASK_fix_semantic_false_face.md         # 本文件

output/
  semantic-false-face-diagnosis/
    high-risk-samples.csv                 # Top 50 高风险样本列表
    grounded-vs-flat-comparison.md        # 10-20 个样本的对比分析
    diagnosis-report.md                   # 诊断总结报告

    teacher-prompt-v1.1-optimized.txt     # 优化后的 teacher prompt

    patched-samples.json                  # 选中的 100-200 个重标注样本列表
    semantic-teacher-v1.1-patched.jsonl   # 重标注结果

    student-v2.1-training-report.json     # 增量训练或重训练报告

    fix-validation-report.md              # 验证报告
    false-face-risk-before-after.csv      # 修复前后对比
```

## 时间估算

- Phase 1 诊断分析: 2-3 小时（含人工抽查样本）
- Phase 2 prompt 优化: 1 小时
- Phase 3 增量重标注 + 验证: 3-4 小时（teacher 推理 + student 训练 + 验证）
- Phase 4 全量重标注（可选）: 6-8 小时

**总计**: 6-8 小时（不含 Phase 4）

## 风险与限制

1. **可能无法完全消除假脸误判**
   - VLM teacher 本身在 landscape 中的人脸检测可能有局限
   - 可能需要引入专门的 face detection 模型作为 pre-filter

2. **召回率可能轻微下降**
   - 收紧 face region 判断可能导致部分真人脸被遗漏
   - 需要在 false-face risk 和 recall 之间权衡

3. **Student 可能对 teacher 噪声敏感**
   - 即使 teacher 标注改善，student 可能已经学到了旧的偏差
   - 可能需要调整 face_validity loss 的权重

## 下一步（如果本 task 成功）

1. 如果 false-face risk 降低到可接受水平，重新评估是否进入产品候选
2. 将优化后的 teacher prompt 固化到代码中（不要只留在实验笔记）
3. 在真实用户 A/B 测试中验证假脸误判是否真的改善
4. 考虑后续引入专门的 face detection pre-filter（SCRFD/RetinaFace）作为 teacher 辅助
