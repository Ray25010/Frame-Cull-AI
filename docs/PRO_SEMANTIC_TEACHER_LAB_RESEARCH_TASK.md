# FrameCull Pro Semantic Teacher Lab 科研流程任务书

## Material Passport

- 产出日期：2026-06-22
- 使用技能：`research`、`research-deep`
- 技能状态：本机已安装，路径分别为 `C:\Users\29238\.codex\skills\research` 与 `C:\Users\29238\.codex\skills\research-deep`
- 工程权威规格：`docs/GOAL_pro_semantic_teacher_lab.md`、`docs/PRO_MODEL_ARCHITECTURE.md`
- 外部来源核查：已按 2026-06-22 可访问公开资料核查 CVPR 2026 / arXiv / Hugging Face / GitHub 来源
- 当前状态：科研规划完成，进入可执行实验拆解
- Research outline：`research/framecull-pro-semantic-teacher-lab/outline.yaml`
- Research fields：`research/framecull-pro-semantic-teacher-lab/fields.yaml`
- Deep research results：`research/framecull-pro-semantic-teacher-lab/results/*.json`

## 一句话结论

FrameCull Pro 下一阶段不应该把大模型直接塞进客户端，而是做一个服务器侧的 **Semantic Teacher Lab**：用 5090 工作站上的 VLM teacher 读取高分辨率原图，生成带视觉证据的语义软标签，再蒸馏到能在消费级显卡上跑的 Pro Student V2 多头模型。

核心不是让模型“说得像懂了”，而是让 teacher 输出能被审计的结构：

- `reasoningTrace`：区域 -> 视觉证据 -> 支持/反对保留
- `faceRegionVerdicts`：疑似人脸区域 -> 真/假脸判断 -> 证据
- `semanticKeepScore`：必须能回溯到 trace，不能凭空给一个标量分
- `faceValidityScore` / `falseFaceRisk`：必须从区域级 verdict 汇总

如果 grounded teacher 比 flat-scalar teacher 没有明显增益，就说明“内容理解”只是口号，不能进入产品。

## 调研结论

### 1. CVPR 2026 的参考价值

CVPR 2026 相关工作给我们的启发不是“照搬某一篇模型”，而是方法论：

- Mirage / Machine Mental Imagery 强调多模态模型不能只靠文字推理，而要形成内部视觉表征，再基于这些表征推理。
- Grounded Chain-of-Thought 强调推理步骤要和图像区域证据绑定，而不是只输出一段看起来合理的解释。
- G2VLM 强调把几何/空间 grounding 融入 VLM，让模型先理解空间结构再回答问题。
- DeepScan 强调先做层级扫描和证据提取，再基于证据进行视觉推理。

对应到 FrameCull：我们不需要复现这些论文里的完整训练框架，也不需要把它们的大模型塞进产品。我们要吸收的是 **先形成视觉证据，再给筛片判断** 的流程，把它落到 teacher schema、student heads 和 grounded-vs-flat 消融实验里。

落地边界：

- 不把“理解画面内容”当宣传词，必须表现为可审计字段：`reasoningTrace`、`faceRegionVerdicts`、`regions`。
- 不让 teacher 只输出一个漂亮分数；`semanticKeepScore` 必须能追溯到区域证据。
- 不用 2026 论文替代现有 Pro 架构；它们只指导 teacher 标注方式和评估问题。
- 如果 grounded teacher 不赢 flat-scalar teacher，就不把“内容理解”作为产品卖点。

已核查的公开来源显示：Qwen2.5-VL-7B-Instruct 模型页标注为 `apache-2.0`，并明确支持目标定位、坐标/属性结构化输出；DINOv2 仓库说明代码和模型权重使用 Apache License 2.0；IQA-PyTorch / PyIQA 的仓库和权重存在非商业授权信息，因此 MUSIQ/IQA 只能先按实验 teacher 使用，正式商用蒸馏前必须单独做 license gate。

### 2. Teacher 候选

首选 teacher：`Qwen2.5-VL-7B-Instruct`

原因：

- 有较强图像理解、目标定位、结构化输出能力。
- 7B 级别适合 5090 32GB 离线跑。
- 适合输出 JSON、区域框、场景解释、假脸判断。

备选/对照 teacher：`InternVL3-8B/14B`

用途：

- 做第二 teacher 或交叉一致性检查。
- 如果 license 或显存不满足，只作为研究对照，不参与正式蒸馏。

独立质量/特征 teacher：

- `DINOv2`：提供 `dino[768]` 视觉 embedding，用于 `L_embedding`。
- `CLIP`：提供语义 embedding 和场景辅助。
- `MUSIQ / IQA`：提供技术质量和通用美学分，但不能代表摄影师偏好。

### 3. License 是硬门禁

全量 teacher 标注前必须先产出 `teacher-license-clearance.md`。

原因很简单：teacher 输出会被蒸馏进最终 student 权重，而 student 未来可能随 Pro 包分发。也就是说，teacher license 不只是“能不能离线跑”，还要确认：

- 是否允许用模型输出训练下游模型。
- 是否允许下游模型商业分发。
- 是否要求额外声明、署名或限制使用场景。

不清楚或非商业的 teacher 只能做研究对照，不能产正式 student 训练标签。

## 研究问题

RQ1：语义 teacher 标签是否能提升 `38% / 45% / 50%` 低精选比例下的人工可用片召回？

RQ2：它是否能减少空镜、大景、环境人像、纪实瞬间被技术分系统性压低的问题？

RQ3：区域级假脸判断是否能降低轮胎、灯、圆形物体被误识别人脸的问题？

RQ4：grounded teacher 是否真的优于 flat-scalar teacher？

RQ5：蒸馏后的 Pro Student V2 是否能在 6GB 消费级独显和 CPU fallback 下达到可接受速度？

## 数据口径

### 数据集

| 数据集 | 本地路径 | 服务器路径 | 正样本口径 |
|---|---|---|---|
| G 盘三组验证集 | `D:\FrameCullRawAudit\raw-audit-previews` | `/data/FrameCullModelLab/incoming/raw-audit-previews` | `rating >= 3` |
| 相机扩展集 | `D:\FrameCullRawAudit\camera-audit-previews` | `/data/FrameCullModelLab/incoming/camera-previews-384` | `rating >= 1` |
| 相机原图 | `E:\BaiduNetdiskDownload\相机` | `/data/FrameCullModelLab/incoming/camera-original/相机` | 同相机扩展集 |
| 相机 teacher 图 | 由相机原图生成 | `/data/FrameCullModelLab/incoming/camera-teacher-jpegs` | 只作为 VLM teacher 输入 |

### 红线

- teacher 读高分辨率原图，不读 384 预览图。
- 相机 RAW 先转成高分辨率 teacher JPEG，再给 VLM；这一步不是 384 preview fallback。
- 384 只用于 student 训练/推理输入。
- 星级只用于训练标签和评估指标，不进入 teacher prompt、student 输入、排序特征。
- 文件夹、路径、文件名不进入排序特征。
- 无星级和 0 星在相机集里视为淘汰。
- G 盘旧验证集不能用 `rating>=1`，必须用 `rating>=3`。

## Teacher Schema 要求

每张图输出一条 JSONL，最小必需字段：

```json
{
  "schemaVersion": "framecull-semantic-teacher-v1",
  "photoId": "DSC0001",
  "imagePath": "/data/FrameCullModelLab/incoming/camera-teacher-jpegs/DSC0001.jpg",
  "teacherModel": "qwen2.5-vl-7b-instruct",
  "sceneType": "environmental_portrait",
  "sceneConfidence": 0.82,
  "semanticKeepScore": 0.74,
  "faceValidityScore": 0.91,
  "falseFaceRisk": 0.02,
  "compositionScore": 0.68,
  "momentScore": 0.72,
  "lightingMoodScore": 0.65,
  "reasoningTrace": [
    {
      "region": [0.12, 0.18, 0.74, 0.88],
      "observation": "subject is clearly framed by the environment",
      "supportsKeep": true,
      "weight": 0.7
    }
  ],
  "faceRegionVerdicts": [
    {
      "region": [0.33, 0.21, 0.48, 0.42],
      "isRealHumanFace": true,
      "evidence": "facial features align with a visible body",
      "confidence": 0.93
    }
  ],
  "uncertain": []
}
```

QA-only 字段可以输出，但不建 student head：

- `storytellingScore`
- `emptyOrFillerScore`
- `technicalVisibleIssueScore`
- `scenicValueScore`

## 实验流程

### Phase 0：数据和环境审计

目标：确认服务器、数据、标签、原图路径都可用。

相机 RAW 需要先生成高分辨率 teacher JPEG，避免 VLM 直接读 ARW 失败，也避免退回 384 预览图。该步骤应在数据审计前完成：

```bash
cd /data/FrameCullModelLab/workspace
/home/hph/miniconda3/envs/train5090/bin/python tools/pro-train/prepare_semantic_teacher_images.py \
  --input /data/FrameCullModelLab/incoming/camera-original/相机 \
  --out /data/FrameCullModelLab/incoming/camera-teacher-jpegs
```

交付物：

- `data-audit.json`
- `data-audit.md`
- `all-images.json`
- `smoke-list.json`

验收：

- 每条 teacher 记录都有高分辨率 `teacherImagePath`。
- teacher manifest 不使用 384 preview fallback。
- G 盘和相机集分别记录自己的正样本阈值。

### Phase 1：Teacher license gate + smoke

目标：先确认合法可用，再跑 80 张 smoke。

交付物：

- `teacher-license-clearance.md`
- `smoke-qwen2.5-vl.jsonl`
- `teacher-smoke-summary.json`
- `teacher-failures.csv`

验收：

- 至少一个 teacher 被标记为 cleared。
- smoke JSONL schema 通过。
- `reasoningTrace` 和 `faceRegionVerdicts` 覆盖率达标。
- 失败样本可 resume，不影响整批。

### Phase 2：全量 Semantic Teacher 标注

目标：对全量训练/验证图生成 grounded teacher 标签。

交付物：

- `semantic-teacher-v1.jsonl`
- `semantic-teacher-v1.summary.json`
- `teacher-quality-report.md`
- `teacher-qa-samples.csv`

验收：

- schema 校验通过。
- 每个场景类型有分布统计。
- 低置信、冲突、疑似假脸样本单独列出。
- teacher 输出不包含星级、路径推断、文件名推断。

### Phase 2.5：质量/嵌入 teacher 特征

目标：补齐 student distillation 的非 VLM teacher 输入。

必须生成：

- `musiq_tech`
- `musiq_aes`
- `clip[512]`
- `dino[768]`

交付物：

- `teacher-camera.npz`
- `teacher-audit3groups.npz`
- `teacher-feature-summary.json`

验收：

- DINOv2 不得缺失。
- 这些特征跑 384 student 输入，不和 VLM teacher 的高分辨率原图链路混用。

### Phase 3：Pro Student V2 多头训练

默认 student：`ConvNeXt-Tiny`

候选 student：小 ViT / DeiT-Tiny，仅当 6GB 显存和 DirectML/CoreML 算子验证通过时保留。

训练目标：

- `L_aesthetic`：MUSIQ aesthetic
- `L_scene`：teacher sceneType
- `L_semantic_keep`：teacher semanticKeepScore
- `L_face_validity`：teacher faceValidityScore + 假脸 hard negatives
- `L_persona`：人工星级 weighted BCE + pairwise ranking
- `L_embedding`：CLIP/DINOv2 cosine

交付物：

- `student-best.pt`
- `training-report.json`
- `feature-importance.csv`
- `ablation-report.md`

验收：

- 只建映射表里明确需要的 heads。
- QA-only 字段不建 head。
- G 盘和相机集按各自阈值报告召回。
- 不把 Flash 链路改成 Pro 模型。

### Phase 4：ONNX / INT8 导出

交付物：

- `model.onnx`
- `model.int8.onnx`
- `manifest.json`
- `manifest.int8.json`
- `export-report.json`
- `quant-compare.json`
- `selected-model-manifest.json`

Pro 输出字段：

- `aesthetic`
- `sceneLabel`
- `sceneConfidence`
- `personaScore`
- `semanticKeepScore`
- `faceValidityScore`
- `compositionScore`
- `momentScore`
- `lightingMoodScore`
- `falseFaceRisk`

验收：

- FP32 和 INT8 都能被现有 Pro native infer layer 加载。
- INT8 分数漂移超阈值时不得进入候选。
- 坏图只返回单图 `error`，不挂整批。

### Phase 5：A/B 评估和消融

对比组：

- `current-production-rules`
- `ratio-aware-rules`
- `pro-persona-v1`
- `pro-semantic-v2-persona-only`
- `pro-semantic-v2-semantic-only`
- `pro-semantic-v2-fused`
- `pro-semantic-v2-face-guard`
- `pro-semantic-v2-flat-scalar`

比例：

- `38%`
- `45%`
- `50%`
- `60%`

交付物：

- `summary.md`
- `metrics-by-ratio.csv`
- `metrics-by-scene.csv`
- `false-negatives-by-ratio.csv`
- `duplicate-pollution-by-ratio.csv`
- `false-face-samples.csv`
- `grounded-vs-flat-ablation.md`
- `pro-infer-latency.csv`

验收：

- 每个数据集按自己的正样本口径报告，不混成一个阈值。
- 报告空镜/大景/环境人像/纪实瞬间的分层表现。
- `grounded` 必须和 `flat-scalar` 单独对比。
- hard issue picked 必须为 0。
- 重复组非代表不得被模型救回。

### Phase 6：产品进入门槛

进入 Pro gated ranking 的最低条件：

- 任一低比例 `38% / 45% / 50%` 召回提升 `>= 5%`，或 4/5 星覆盖提升 `>= 8%`。
- 负样本混入率恶化不超过 `2%`。
- 重复污染不恶化。
- blocked / hard issue picked 为 `0`。
- 假脸误报降低，至少不高于现有规则。
- DirectML 和 CPU fallback 性能可接受。

不达标时：

- 不接入默认 Pro ranking。
- 保留 teacher 标签、训练报告和失败分析。
- 下一轮再判断是 teacher 不稳、student 容量不足、标签口径问题，还是训练数据场景偏差。

## 服务器目录规范

```text
/data/FrameCullModelLab/
  incoming/
    raw-audit-previews/
    camera-previews-384/
    camera-original/
      相机/
    camera-teacher-jpegs/
    camera-labels/
  cache/
    huggingface/
    torch/
    pip/
    tmp/
  features/
    teacher/
    semantic-teacher/
  outputs/
    semantic-teacher-lab/
    semantic-student-v2/
  workspace/
    tools/
      pro-train/
      ai-lab/
    output/
      ai-bench/
```

所有重型模型、缓存、临时文件都放 `/data/FrameCullModelLab`，不写系统盘，不上传第三方云。

## 当前可执行状态

- `research` 与 `research-deep` 已在本机 Codex skills 目录中可用。
- 已生成 research planning 文件：
  - `research/framecull-pro-semantic-teacher-lab/outline.yaml`
  - `research/framecull-pro-semantic-teacher-lab/fields.yaml`
- 已生成 deep research 结果：
  - `research/framecull-pro-semantic-teacher-lab/results/cvpr_2026_grounded_visual_reasoning.json`
  - `research/framecull-pro-semantic-teacher-lab/results/semantic_teacher_selection.json`
  - `research/framecull-pro-semantic-teacher-lab/results/teacher_schema_and_quality_gates.json`
  - `research/framecull-pro-semantic-teacher-lab/results/quality_and_embedding_teachers.json`
  - `research/framecull-pro-semantic-teacher-lab/results/pro_student_v2_distillation.json`
  - `research/framecull-pro-semantic-teacher-lab/results/evaluation_and_product_gate.json`
- 本地 smoke 已通过：
  - `tools/pro-train/*.py` 全部通过 `py_compile`
  - `tools/ai-lab/bench-pro-semantic-student.mjs` 与 `tools/ai-lab/tune-ai-picks-supervised.mjs` 通过 `node --check`
  - heuristic grounded teacher 写入 1 条 JSONL，schema 校验 `failed=0`
  - heuristic flat-scalar teacher 写入 1 条 JSONL，`--allow-flat-scalar` schema 校验 `failed=0`
- 本任务书是后续执行的主入口；若与 `docs/GOAL_pro_semantic_teacher_lab.md` 冲突，以 `docs/GOAL_pro_semantic_teacher_lab.md` 为准。

## 建议命令草案

### 数据审计

```bash
cd /data/FrameCullModelLab/workspace
/home/hph/miniconda3/envs/train5090/bin/python tools/pro-train/audit_semantic_inputs.py \
  --gdrive-previews /data/FrameCullModelLab/incoming/raw-audit-previews \
  --gdrive-labels /data/FrameCullModelLab/incoming/raw-audit-previews/labels.json \
  --gdrive-original-dirs /data/FrameCullModelLab/incoming/raw-audit-previews \
  --camera-previews /data/FrameCullModelLab/incoming/camera-previews-384 \
  --camera-labels /data/FrameCullModelLab/incoming/camera-labels/camera-labels-final.json \
  --camera-original-dirs /data/FrameCullModelLab/incoming/camera-teacher-jpegs \
  --out /data/FrameCullModelLab/outputs/semantic-teacher-lab/phase0
```

### License gate

```bash
/home/hph/miniconda3/envs/train5090/bin/python tools/pro-train/teacher_license_clearance.py \
  --teachers qwen2.5-vl-7b,internvl3-8b \
  --out /data/FrameCullModelLab/outputs/semantic-teacher-lab
```

### Teacher smoke

```bash
/home/hph/miniconda3/envs/train5090/bin/python tools/pro-train/run_semantic_teacher.py \
  --input /data/FrameCullModelLab/outputs/semantic-teacher-lab/phase0/smoke-list.json \
  --out /data/FrameCullModelLab/features/semantic-teacher/smoke-qwen2.5-vl.jsonl \
  --backend qwen2_5_vl \
  --model Qwen/Qwen2.5-VL-7B-Instruct \
  --limit 80 \
  --resume
```

### Flat-scalar ablation

```bash
/home/hph/miniconda3/envs/train5090/bin/python tools/pro-train/run_semantic_teacher.py \
  --input /data/FrameCullModelLab/outputs/semantic-teacher-lab/phase0/smoke-list.json \
  --out /data/FrameCullModelLab/features/semantic-teacher/smoke-flat-scalar.jsonl \
  --backend qwen2_5_vl \
  --model Qwen/Qwen2.5-VL-7B-Instruct \
  --flat-scalar \
  --limit 80 \
  --resume
```

### Teacher QA

```bash
/home/hph/miniconda3/envs/train5090/bin/python tools/pro-train/audit_semantic_teacher.py \
  --teacher /data/FrameCullModelLab/features/semantic-teacher/smoke-qwen2.5-vl.jsonl \
  --out /data/FrameCullModelLab/outputs/semantic-teacher-lab/teacher-qa-smoke
```

### 质量/嵌入 teacher 特征

```bash
/home/hph/miniconda3/envs/train5090/bin/python tools/pro-train/build_quality_teacher_features.py \
  --camera-previews /data/FrameCullModelLab/incoming/camera-previews-384 \
  --audit-previews /data/FrameCullModelLab/incoming/raw-audit-previews \
  --out-dir /data/FrameCullModelLab/features/teacher
```

### Student 训练

```bash
/home/hph/miniconda3/envs/train5090/bin/python tools/pro-train/train_semantic_student.py \
  --backbone convnext_tiny \
  --semantic-teacher /data/FrameCullModelLab/features/semantic-teacher/semantic-teacher-v1.jsonl \
  --quality-teacher-dir /data/FrameCullModelLab/features/teacher \
  --labels-camera /data/FrameCullModelLab/incoming/camera-labels/camera-labels-final.json \
  --labels-audit /data/FrameCullModelLab/incoming/raw-audit-previews/labels.json \
  --out /data/FrameCullModelLab/outputs/semantic-student-v2/convnext_tiny \
  --epochs 30 \
  --batch 64
```

### 导出和评估

```bash
/home/hph/miniconda3/envs/train5090/bin/python tools/pro-train/export_pro_semantic_onnx.py \
  --student /data/FrameCullModelLab/outputs/semantic-student-v2/convnext_tiny/student-best.pt \
  --out output/pro-models/semantic_student_v2_convnext \
  --name framecull-pro-semantic-v2

node tools/ai-lab/bench-pro-semantic-student.mjs \
  --manifest output/pro-models/semantic_student_v2_convnext/manifest.int8.json \
  --output output/ai-bench/pro-semantic-student-eval \
  --ratios 0.38,0.45,0.50,0.60
```

## 必交付文件

最终实验至少要产出：

- `teacher-quality-report.md`
- `teacher-license-clearance.md`
- `summary.md`
- `metrics-by-ratio.csv`
- `metrics-by-scene.csv`
- `false-negatives-by-ratio.csv`
- `duplicate-pollution-by-ratio.csv`
- `false-face-samples.csv`
- `grounded-vs-flat-ablation.md`
- `pro-infer-latency.csv`
- `selected-config-by-ratio.json`
- `selected-model-manifest.json`
- `production-recommendation.md`

## 风险与应对

| 风险 | 表现 | 应对 |
|---|---|---|
| teacher 幻觉 | JSON 看似合理但证据不对 | schema + QA 抽样 + uncertain 字段 + 第二 teacher 对照 |
| license 不清 | teacher 可跑但不能商用蒸馏 | Phase 1 前置 license gate，未通过只做研究对照 |
| student 学不到 grounded 信息 | teacher QA 好但 student 指标不升 | 降低任务复杂度，增强 face/semantic heads，换 backbone |
| flat-scalar 同样有效 | grounded trace 没带来额外收益 | 如实写入 `grounded-vs-flat-ablation.md`，不宣传“理解画面” |
| 相机集标签口径污染 | 1 星可用和 G 盘 3 星口径混淆 | 每个数据集分开阈值和分开报告 |
| 假脸仍高 | 轮胎/灯/圆形物体误识别 | 加 hard negatives，强制 faceRegionVerdicts 证据链 |
| INT8 漂移 | 量化后排序变差 | 保留 FP32 对照，漂移超阈值不上 INT8 |
| Pro 速度不够 | DirectML/CPU 太慢 | batch 调优，ConvNeXt 优先，小 ViT 只做候选 |

## 下一步执行 Prompt

```text
Implement FrameCull Pro Semantic Teacher Lab v1 according to docs/PRO_SEMANTIC_TEACHER_LAB_RESEARCH_TASK.md and docs/GOAL_pro_semantic_teacher_lab.md.

Do Phase 0 to Phase 6 in order. Use the 5090 server under /data/FrameCullModelLab for teacher labeling, feature extraction, and student training. Keep all heavy model files, HuggingFace cache, Torch cache, pip cache, and temporary files under /data/FrameCullModelLab. Do not upload RAW or private photos to third-party cloud APIs.

Teacher must read high-resolution originals, not 384 previews. 384 previews are only for student input and quality/embedding teacher features. Teacher output must be schema-validated JSONL with reasoningTrace and faceRegionVerdicts. Run a flat-scalar ablation with the same teacher and images.

Before full annotation, generate teacher-license-clearance.md and use only cleared teachers for official labels. Qwen2.5-VL-7B is the first candidate; InternVL3 is a comparison candidate if license and VRAM allow. Generate MUSIQ, CLIP[512], and DINOv2 dino[768] features before student training.

Train Pro Student V2 as a shared-backbone multi-head model. Build only heads mapped to ProHeadScores: aesthetic, scene, persona, semanticKeepScore, faceValidityScore/falseFaceRisk, compositionScore, momentScore, and lightingMoodScore. Do not build heads for QA-only fields. Keep Flash fully isolated.

Apply label thresholds per dataset: G-drive/audit3groups positive is rating>=3; camera and other datasets positive is rating>=1. Report metrics per dataset and per scene. Do not average away the threshold difference.

Export FP32 and INT8 ONNX manifests compatible with the Pro native inference layer. Evaluate current rules, Pro persona v1, semantic-only, fused, face-guard, and flat-scalar at 38%, 45%, 50%, and 60%.

Final output must include teacher-quality-report.md, teacher-license-clearance.md, summary.md, metrics-by-ratio.csv, metrics-by-scene.csv, false-negatives-by-ratio.csv, duplicate-pollution-by-ratio.csv, false-face-samples.csv, grounded-vs-flat-ablation.md, pro-infer-latency.csv, selected-config-by-ratio.json, selected-model-manifest.json, and production-recommendation.md.
```

## Sources

- CVPR 2026 Open Access Repository: https://openaccess.thecvf.com/CVPR2026
- Mirage / Machine Mental Imagery, CVPR 2026: https://openaccess.thecvf.com/content/CVPR2026/html/Yang_Machine_Mental_Imagery_Empower_Multimodal_Reasoning_with_Latent_Visual_Tokens_CVPR_2026_paper.html
- Grounded Chain-of-Thought, CVPR 2026: https://openaccess.thecvf.com/content/CVPR2026/html/Wu_Grounded_Chain-of-Thought_for_Multimodal_Large_Language_Models_CVPR_2026_paper.html
- G2VLM, CVPR 2026: https://openaccess.thecvf.com/content/CVPR2026/html/Hu_G2VLM_Geometry_Grounded_Vision_Language_Model_with_Unified_3D_Reconstruction_CVPR_2026_paper.html
- DeepScan, CVPR 2026: https://openaccess.thecvf.com/content/CVPR2026/html/Li_DeepScan_A_Training-Free_Framework_for_Visually_Grounded_Reasoning_in_Large_CVPR_2026_paper.html
- Qwen2.5-VL Technical Report: https://arxiv.org/abs/2502.13923
- Qwen2.5-VL-7B-Instruct: https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct
- InternVL3 Technical Report: https://arxiv.org/abs/2504.10479
- DINOv2 repository and license: https://github.com/facebookresearch/dinov2
- DINOv2 paper: https://arxiv.org/abs/2304.07193
- CLIP repository: https://github.com/openai/CLIP
- CLIP paper: https://arxiv.org/abs/2103.00020
- MUSIQ paper: https://arxiv.org/abs/2108.05997
- IQA-PyTorch repository: https://github.com/chaofengc/IQA-PyTorch
