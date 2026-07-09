# FrameCull Pro Semantic Teacher Lab 任务计划

## Material Passport

- Origin Skills: `research` + `research-deep` + `academic-research-suite/experiment-agent`
- Origin Mode: research planning + deep research + code experiment plan
- Origin Date: 2026-06-22
- Verification Status: PLANNED
- Version Label: semantic_teacher_lab_v1

## 一句话结论

核心目标是**让美学/筛片打分能「看懂画面内容」**：把能理解画面内容的大视觉语言模型放在 **5090（32GB）服务器**上当 **Semantic Teacher**，离线给训练集生成「画面内容理解、主体关系、场景类型、保留理由、假人脸/伪主体」等软标签，再蒸馏到一个**能在 6GB 消费级独显上跑得动**的 **Pro Student V2 多头模型**。

定位三条，按优先级：

1. **以美学/筛片偏好打分为主线**——「内容理解」是手段，目的是让美学头不再被空镜、大景、纪实瞬间这类「无明显主体」的画面系统性压低。
2. **保留多头实验室**——美学、场景、个性（persona）三头同时蒸，外加语义 keep / 假脸验证等辅助头；共享 backbone 跑一次特征喂所有头。
3. **模型选型由可落地算力定**——teacher 必须能在 5090 32GB 上跑/训/产标签；student 蒸馏后必须能在 6GB 独显（GTX1660/RTX2060/3050 档）跑得动，不靠某一篇具体论文的范式拍板。

> 「内容理解」是一类**通用能力**（VLM 语义标注 + 带证据的接地描述），不绑定任何单篇论文。下文凡涉及「接地推理」均指这一通用能力，不特指某模型。

## 背景与已知现状

FrameCull 当前已经有三条实验线：

- Flash：轻量规则 + wasm worker，不引入大模型、不引入 `ort/ndarray`、不放 ONNX Pro 模型。
- Pro：已有 Rust 进程内 `onnxruntime` 推理层，模型入口为 `pro_infer_init` / `pro_infer_batch`，真实模型通过 manifest 替换。
- Pro 模型 V1：已有 `ConvNeXt INT8 persona` 实验模型包，路径为 `output/pro-models/convnext_persona_v1_linear_int8_final/manifest.int8.json`。

已有数据：

- G 盘三组人工星级验证集：`D:\FrameCullRawAudit\raw-audit-previews`
- 相机扩展集：`D:\FrameCullRawAudit\camera-audit-previews`
- 相机标签：`D:\FrameCullRawAudit\camera-labels\camera-labels-final.json`
- 合并监督评估脚本：`tools/ai-lab/tune-ai-picks-supervised.mjs`
- Pro persona 评估脚本：`tools/ai-lab/bench-pro-persona.mjs`
- Pro 训练脚本：`tools/pro-train/train_distill_backbone.py`、`tools/pro-train/train_persona_head.py`、`tools/pro-train/export_pro_onnx.py`

当前问题：

- 小型 Flash 筛选头没有达到默认进入 Flash 的门槛。
- Pro V1 persona 模型能跑通链路，但语义理解仍弱，不能可靠解释“为什么空镜/大景/纪实瞬间值得保留”。
- 轮胎等局部纹理可能被误认为人脸，本质上需要上下文语义验证，而不是只靠局部人脸检测阈值。

## 研究问题

主问题：

> 使用大视觉语言模型 / 视觉推理模型生成的语义 teacher 标签，是否能显著提升 FrameCull Pro 在真实摄影筛片中的低比例召回与泛化能力？

子问题：

- RQ1：语义 teacher 标签能否提升 `38% / 45% / 50%` 低精选比例下的人工可用片召回？
- RQ2：语义 teacher 能否减少空镜、大景、环境人像、纪实瞬间被技术分系统性压低的问题？
- RQ3：上下文语义验证能否降低轮胎、灯、圆形物体等被误识别为人脸的假阳性？
- RQ4：蒸馏后的 Pro Student V2 是否能在 DirectML / CPU fallback 下达到可接受速度与包体？
- RQ5：语义分数是否能在不破坏硬伤门禁、重复组选优、弃用逻辑的前提下改善 AI Pick 排序？

## 外部研究依据

| 方向 | 代表来源 | 对 FrameCull 的启发 |
|---|---|---|
| 开源 VLM teacher | [Qwen2.5-VL Technical Report](https://arxiv.org/abs/2502.13923) | 强项是视觉识别、目标定位和结构化输出，能在 5090 32GB 上跑，适合做首批 teacher。 |
| 开源多模态泛化 | [InternVL3](https://arxiv.org/abs/2504.10479) | 适合作为第二 teacher 或交叉一致性检查，降低单 teacher 偏差。 |
| 通用视觉特征 | [DINOv2](https://arxiv.org/abs/2304.07193) | 可作为无语言视觉 embedding teacher，提高跨场景稳定性。 |
| 语义对齐 | [CLIP](https://arxiv.org/abs/2103.00020) | 可继续作为轻量语义检索/场景 embedding teacher。 |
| 图像质量 | [MUSIQ](https://arxiv.org/abs/2108.05997) | 仍适合做技术/美学质量 teacher，但不能单独代表摄影师筛片偏好。 |

> 「内容理解」的灵感来自「让模型先理解画面内容、再判断」这一类思路（业界有多篇相关工作，如视觉 latent 推理方向）。本计划**不绑定任何单篇论文**，只取其通用做法：teacher 端先产出带视觉证据的接地描述，再汇成分数。是否采用某具体范式，由「能否在 5090 上落地 + 能否带来可测增量」决定，不靠先验。

研究结论边界：

- VLM teacher 的价值是「在服务器侧产出能解释画面内容的软标签」，不是把大模型塞进产品。
- Qwen2.5-VL / InternVL3 适合服务器离线标注；是否允许商用、是否可随包分发，需要单独 license 审核。
- DINOv2 / CLIP / MUSIQ 是特征与分数 teacher，不负责最终筛片偏好。

### 让打分「看懂内容」的落地方式（核心，不能只挂名）

目标是让美学/筛片打分**基于对画面内容的理解**，而不是从像素直接跳到一个来路不明的标量分。落地约束与做法：

**约束**：能在 6GB 独显上跑的本地 student（ConvNeXt/ViT-Tiny，几 MB~几十 MB）在推理时**跑不了大模型的中间推理**，也不该跑。所以「内容理解」只能落在 **teacher 侧**（5090 上的 VLM），再把理解的**产物**蒸馏进 student。

**做法（三条，必须落到 schema 与 loss）**：

1. **接地描述而非扁平标量**：teacher 对每张图先产出 `reasoningTrace`——对关键区域逐个给「区域 box → 观察到的视觉证据 → 该证据如何支持/反对保留」，最后才汇成 `semanticKeepScore`。分数必须能回溯到区域证据，不允许凭空给分。这是「看懂内容」在 schema 上的落点。
2. **假脸走区域级视觉判断**（直接回应 RQ3）：对每个「疑似人脸」区域，teacher 必须基于上下文证据判定真假（「圆形+胎纹+位于车轮位置→非人脸」），输出带证据的 `faceRegionVerdicts`，而不是只给一个 `falseFaceRisk` 标量。student 的 face-validity head 蒸的是这套带区域条件的判定结果。
3. **空镜/大景的「无人脸≠低价值」判断**（回应 RQ2，直接服务美学打分）：teacher 必须显式说明场景的叙事/构图价值，证据写进 trace，避免美学/技术分体系因「无主体人脸」系统性压低空镜大景。

> 一句话：teacher 产出**可回溯到视觉证据的接地标签**，student 蒸的是这套理解的结论与区域接地信号——而不是一个来路不明的标量分。接地标签是否真的带来增量，由 §实验设计里的「接地标签 vs 纯标量」消融证明（见 Phase 5），数据说话，不靠论文背书。

## 算力可落地约束（选型硬边界，先于一切模型选择）

模型选型不靠论文范式，靠两端真实硬件：teacher 在自有 5090 上能跑/能训/能产标签，student 蒸馏后能在消费级独显跑得动。任何不满足下表的候选直接出局。

### Teacher 侧（5090，32GB，离线标注 + 训练）

| 维度 | 约束 | 说明 |
|---|---|---|
| 显存 | 单卡 ≤ 32GB | 不依赖多卡/云 API；超 32GB 的 teacher 不进本计划，必要时用量化推理压进显存 |
| 速度 | 允许慢 | 只在服务器离线一次性跑，支持 resume；标注吞吐不是硬指标 |
| 候选 | Qwen2.5-VL 7B（首选）、InternVL3 8B/14B（次选/对照） | 14B 需先确认 32GB 够，否则量化或降级为对照 |
| 用途 | 产 grounded 软标签 + 训练 student | teacher 本身**不下发**，只产标签 |

### Student 侧（消费级独显，下发到客户端）

| 档位 | 目标硬件 | 约束 | 预期 |
|---|---|---|---|
| **最低（定盘）** | GTX1660 / RTX2060 / 3050，**6GB** | INT8、384 输入、DirectML 可跑，CPU 兜底不挂 | 可用，batch 偏小 |
| 推荐 | RTX3060 / 4060，8GB | 同上，batch 放宽 | 流畅 |
| Apple Silicon | M1/M2 起，统一内存 8GB | CoreML EP，算子回退有日志 | 可用 |

选型纪律：

- **student backbone 默认 ConvNeXt-Tiny**——卷积算子在 DirectML/CoreML 覆盖好、INT8 稳、6GB 可控。DeiT/ViT-Tiny 仅作候选，且**必须先验证 6GB + DirectML/CoreML 下的显存与算子回退**，过不了就回落 ConvNeXt。
- student 参数量/包体上限以「6GB 卡 INT8 能加载 + 推理不爆显存」为准，多头共享 backbone（跑一次特征喂所有头）是省显存的关键，不得每头各带一个 backbone。
- teacher 与 student **跑不同分辨率**：teacher 读高分辨率原图（理解细节、验假脸），student 固定 384 输入。两条链路不可混用。

> 一句话：5090 能跑的当 teacher，6GB 卡能跑的才配当 student。选型先过这道硬边界，再谈精度。

## 非目标与红线

- 不改 Flash wasm 链路。
- 不把大 VLM、CLIP、MUSIQ、DINOv2、ConvNeXt teacher 直接塞进 Flash。
- 不让 `rating / folder / path / filename / manual pick` 进入模型输入特征。
- 不让语义分数救回硬伤片、弃用片、重复组非代表。
- 不上传 RAW 到第三方云服务；teacher 默认在自有 5090 服务器离线跑。
- 不修改 Lightroom catalog，不把 LR 数据库作为训练输入。
- 不在本轮直接替换生产 AI Pick；先做实验报告和 Pro-only gated 模型。

## 数据与标签口径

### 数据集

| 数据集 | 路径 | 标签口径 | 用途 |
|---|---|---|---|
| G 盘三组 | `D:\FrameCullRawAudit\raw-audit-previews` | **正样本 `rating>=3`**（见下方「标签阈值口径」） | 旧摄影师星级验证 |
| 相机扩展集 | `D:\FrameCullRawAudit\camera-audit-previews` | **正样本 `rating>=1`** | 新扩展泛化验证 |
| 服务器镜像 | `/data/FrameCullModelLab/incoming/*` | 同本地（按来源各自口径） | 训练与 teacher 标注 |

> **✅ 标签阈值口径（已定，按数据集分别取）**：**只有 G 盘三组（`audit3groups` / `raw-audit-previews`）用 `rating>=3` 为正样本，其余数据集（相机扩展集等）一律 `rating>=1`。**
> - 依据：G 盘是老摄影师的精选验证集，1 星只是「没删」不代表「想要」，必须抬到 3 星才算正；相机扩展集的星级语义是「1 星即可用」，沿用 `>=1`。
> - **代码现状与待改**：`tools/pro-train/train_persona_head.py` 现在两个数据集都写 `rating>=1`（相机第 103 行**正确**、audit3groups 第 118 行**需改成 `rating>=3`**）。执行时必须把 audit3groups 分支的阈值改掉并重训 persona 头。
> - `rating_weight`（第 124–128 行）按星级强度加权的逻辑两个数据集都保留，不受正样本阈值影响。
> - 每个数据集的 `k` 值（G 盘=3、其余=1）要写进 manifest 与评测报告，按数据集分别报召回，**禁止混成一个平均阈值**。

### 标签纪律

- 星级只用于训练目标、验证指标、样本权重。
- 星级不得进入 teacher prompt 的图片描述输入，也不得进入 student 推理输入。
- 文件名、目录名、拍摄路径不得作为排序特征。
- 训练/验证切分按拍摄批次或来源分组，不按单张随机切，避免连拍泄漏。

## Semantic Teacher 输出 schema

每张图生成一个 JSON record，建议保存为：

`/data/FrameCullModelLab/features/semantic-teacher/semantic-teacher-v1.jsonl`

```json
{
  "schemaVersion": "framecull-semantic-teacher-v1",
  "photoId": "DSC07306",
  "imagePath": "/data/FrameCullModelLab/incoming/camera-originals/DSC07306.jpg",
  "teacherModel": "qwen2.5-vl-7b-instruct",
  "teacherVersion": "recorded-model-id-or-sha",
  "createdAt": "2026-06-22T00:00:00Z",
  "sceneType": "environmental_portrait",
  "sceneConfidence": 0.83,
  "subjectType": "person",
  "subjectConfidence": 0.78,
  "hasRealHumanFace": true,
  "faceValidityScore": 0.91,
  "falseFaceRisk": 0.02,
  "semanticKeepScore": 0.74,
  "compositionScore": 0.68,
  "momentScore": 0.72,
  "lightingMoodScore": 0.65,
  "storytellingScore": 0.7,
  "scenicValueScore": 0.55,
  "technicalVisibleIssueScore": 0.18,
  "emptyOrFillerScore": 0.14,
  "duplicateRepresentativeHint": "unknown",
  "keepReasons": [
    "clear interaction between subject and environment",
    "usable expression and balanced composition"
  ],
  "rejectReasons": [],
  "reasoningTrace": [
    {
      "region": [0.31, 0.18, 0.72, 0.88],
      "observation": "person facing camera, eyes open, mid-action gesture",
      "supportsKeep": true,
      "weight": 0.7
    },
    {
      "region": [0.0, 0.6, 0.4, 1.0],
      "observation": "foreground environment frames the subject, not clutter",
      "supportsKeep": true,
      "weight": 0.3
    }
  ],
  "faceRegionVerdicts": [
    {
      "region": [0.34, 0.2, 0.55, 0.46],
      "isRealHumanFace": true,
      "evidence": "frontal facial features, skin texture, consistent with body below",
      "confidence": 0.93
    }
  ],
  "regions": [
    {
      "label": "main_subject",
      "box": [0.31, 0.18, 0.72, 0.88],
      "confidence": 0.82
    }
  ],
  "uncertain": []
}
```

> `semanticKeepScore` 必须可回溯到 `reasoningTrace` 的区域证据（汇总而非凭空给分）；`faceValidityScore` / `falseFaceRisk` 必须由 `faceRegionVerdicts` 汇出。这是「让打分看懂内容」的 schema 落点——见前文《让打分「看懂内容」的落地方式》。

> **teacher 在高分辨率原图上跑，不在 384 预览图上跑**。384 只是 *student 输入*分辨率（架构文档 §8 已定）。teacher 的语义推理、尤其假脸验证依赖细节，必须喂原图（或至少长边 ≥ 768 的预览）。`camera-previews-384` 仅供 student 训练/推理；teacher 标注的输入路径要指向原图集，二者不可混用。

### 场景类型枚举

首批固定为：

- `portrait`
- `group`
- `environmental_portrait`
- `landscape`
- `empty_scene`
- `documentary_moment`
- `event`
- `product_object`
- `animal`
- `food`
- `other`

### teacher prompt 要求

- 输出必须是 JSON。
- 所有分数范围为 `0..1`。
- 不允许根据星级、文件名、路径推断。
- **必须先产出 `reasoningTrace`（区域→证据→是否支持保留），`semanticKeepScore` 由 trace 汇总，不允许跳过推理直接给分。**
- 对“像脸但不是脸”的区域，必须在 `faceRegionVerdicts` 里逐区域给出**带证据**的真假判定，`falseFaceRisk` 由此汇出，而非单独拍一个标量。
- 对空镜/大景必须在 trace 里推理其叙事/构图价值后再给 `scenicValueScore`，不能因无人脸直接低分。
- teacher 读**高分辨率原图**，不读 384 预览图。
- 如果不确定，写入 `uncertain`，不要编造。

## 实验设计

### Phase 0：环境与数据核验

目标：确认服务器具备跑 teacher 和训练 student 的条件。

输入：

- `/data/FrameCullModelLab/incoming/raw-audit-previews`
- `/data/FrameCullModelLab/incoming/camera-previews-384`
- `/data/FrameCullModelLab/incoming/camera-labels/camera-labels-final.json`
- `/data/FrameCullModelLab/workspace/output/ai-bench/*.json`

输出：

- `/data/FrameCullModelLab/outputs/semantic-teacher-lab/data-audit.json`
- `/data/FrameCullModelLab/outputs/semantic-teacher-lab/data-audit.md`

检查项：

- 图片数量与标签数量一致。
- 标签分布按数据集分别统计。
- 无星/0 星口径确认。
- 训练/验证 split 文件生成，按拍摄批次或来源切分。

### Phase 1：teacher 候选 smoke

候选：

- Qwen2.5-VL 7B：默认首选，结构化输出和目标定位较强，7B 在 5090 32GB 上跑标注余量充足。
- InternVL3 8B/14B：作为第二 teacher 或一致性检查；14B 需确认 5090 显存够（必要时量化推理）。
- DINOv2/CLIP/MUSIQ：继续作为 embedding / quality teacher。

> teacher 选型唯一硬约束：**能在 5090 32GB 上离线跑标注**。允许慢、允许量化推理，但不依赖多卡或云 API。任何要求超过单卡 32GB 的 teacher 不进本计划。

smoke 设置：

- 每个 teacher 跑 80 张图。
- 覆盖人像、合照、大景、空镜、轮胎/假脸风险样本、低星负样本、高星正样本。
- 每张图记录耗时、显存、JSON 解析成功率、uncertain 比例。

通过门槛：

- JSON 有效率 `>= 98%`。
- 单图 teacher 平均耗时可接受，允许慢，因为只在服务器离线跑。
- 人工抽样 50 张，场景类型和保留理由明显可用。
- **`reasoningTrace` / `faceRegionVerdicts` 真的接地**：抽样里区域 box 对得上画面、证据不是套话，假脸样本的判定有上下文依据（否则等于没看懂内容、只是套壳给分，回炉调 prompt）。

> **🚧 License 硬门禁（Phase 2 全量标注前必须过，不是「事后审核」）**：蒸馏出的标签会**烤进随包下发的 student 权重**，所以 teacher 的 license 不是「离线跑就没事」。全量标注**启动前**必须确认：选定 teacher（Qwen2.5-VL / InternVL3 等）的 license 是否允许「用其输出训练模型」且「该模型可商用分发」。结论写进 `teacher-license-clearance.md`，未澄清的 teacher **不得进入 Phase 2 全量标注**。若主选 teacher 不可商用，则降级为「仅研究对照」，改用 license 干净的 teacher 产正式标签。

### Phase 2：全量 semantic teacher 标注

目标：生成可蒸馏的语义软标签。

输出：

- `/data/FrameCullModelLab/features/semantic-teacher/semantic-teacher-v1.jsonl`
- `/data/FrameCullModelLab/features/semantic-teacher/semantic-teacher-v1.summary.json`
- `/data/FrameCullModelLab/features/semantic-teacher/teacher-failures.csv`
- `/data/FrameCullModelLab/features/semantic-teacher/teacher-qa-samples/`

质量控制：

- JSON schema 校验。
- 分数范围校验。
- sceneType 分布校验。
- 高不确定样本导出人工复查。
- 多 teacher 不一致样本单独列出。

### Phase 2.5：量化/嵌入 teacher 特征生成（必须，否则 Phase 3 的 loss 缺输入）

semantic teacher（VLM）只产语义标签。Phase 3 的 `L_aesthetic / L_scene / L_embedding` 还要 MUSIQ/CLIP/DINOv2 的特征，这些**不是 VLM 产的，必须单独跑**。现有 `train_distill_backbone.py` 已经在读 `features/teacher/teacher-*.npz`（含 `tech/aes/clip[512]`），所以这一步是补齐它的输入，且要把 DINOv2 加进去。

输出：

- `/data/FrameCullModelLab/features/teacher/teacher-camera.npz`
- `/data/FrameCullModelLab/features/teacher/teacher-audit3groups.npz`
- 每个 npz 含：`musiq_tech`、`musiq_aes`、`clip[512]`，**以及 `dino[768]`（已定启用，必须生成）**。

纪律：

- 这些 teacher 跑 **384 student 输入分辨率**（要和 student 对齐，蒸的是同尺度特征），与 VLM teacher 跑原图是两条独立链路，不要混。
- **DINOv2 已定启用**：这里必须真生成 `dino[768]`，且 `train_distill_backbone.py` 接上 `L_embedding`（student 特征对齐 DINOv2 embedding，提升跨场景稳定性、抗过拟合到户外人像）。`dino[768]` 缺失即视为 Phase 2.5 未完成，不得进 Phase 3。

### Phase 3：Student V2 训练

模型结构沿用 Pro 设计：

```text
shared backbone
  -> aesthetic head
  -> scene head
  -> persona head
  -> semantic keep head
  -> face validity head
  -> composition/moment/lighting heads
```

候选 backbone（最终以「算力可落地约束」§为准）：

- ConvNeXt-Tiny：低风险主候选，已有 V1 路线，6GB + DirectML/CoreML INT8 稳。
- DeiT/ViT-Tiny：语义上限候选，**仅当通过 6GB 显存 + DirectML/CoreML 算子回退验证才保留**，否则回落 ConvNeXt。

训练分三段：

1. Teacher distillation：学习 MUSIQ / CLIP / DINOv2 / semantic teacher 的软标签。
2. Persona fine-tune：用人工星级训练 `personaScore` 和 ranking head。
3. Scene-balanced calibration：按场景校准，避免相机集或户外人像过拟合。

损失函数建议：

- `L_aesthetic`: MSE / Huber vs MUSIQ aesthetic
- `L_scene`: cross entropy vs teacher sceneType
- `L_semantic_keep`: BCE / ranking loss vs semanticKeepScore
- `L_face_validity`: BCE vs teacher faceValidityScore + 已知假脸样本
- `L_persona`: weighted BCE + pairwise ranking，星级越高权重越高
- `L_embedding`: cosine loss vs DINOv2/CLIP embedding 投影

### Phase 4：ONNX 导出与量化

输出模型目录：

`output/pro-models/semantic_student_v2_<backbone>_<date>/`

必须包含：

- `model.onnx`
- `model.int8.onnx`
- `manifest.json`
- `manifest.int8.json`
- `export-report.json`
- `quant-compare.json`
- `teacher-schema.json`
- `training-report.json`

ONNX 输出字段必须兼容现有 Pro 推理层，新增字段需要先扩展 `ProHeadScores`：

```ts
{
  aesthetic?: number;
  sceneLabel?: string;
  sceneConfidence?: number;
  personaScore?: number;
  semanticKeepScore?: number;
  faceValidityScore?: number;
  compositionScore?: number;
  momentScore?: number;
  lightingMoodScore?: number;
  falseFaceRisk?: number;
  error?: string;
}
```

### 字段映射表（teacher → student head → ProHeadScores，必须对齐）

每个 teacher 字段要么有 student head 承接、要么明确标为「仅 QA 不蒸馏」。**不允许出现 teacher 产出却无人承接的死信号。**

| teacher 字段 | student head | ProHeadScores | 蒸馏 loss |
|---|---|---|---|
| `semanticKeepScore`（由 reasoningTrace 汇总） | semantic_keep | `semanticKeepScore` | BCE/ranking |
| `faceValidityScore` + `faceRegionVerdicts` | face_validity | `faceValidityScore` | BCE + 区域接地 hard neg |
| `falseFaceRisk`（由 faceRegionVerdicts 汇出） | face_validity（同头反向） | `falseFaceRisk` | 同上 |
| `sceneType` | scene | `sceneLabel`/`sceneConfidence` | CE |
| `compositionScore` | composition | `compositionScore` | MSE/Huber |
| `momentScore` | moment | `momentScore` | MSE/Huber |
| `lightingMoodScore` | lighting | `lightingMoodScore` | MSE/Huber |
| `scenicValueScore` | （并入 semantic_keep 的证据，不单独建头） | — | 经 trace 影响 keep |
| `storytellingScore` / `emptyOrFillerScore` | **仅 QA，不蒸馏** | — | — |
| `technicalVisibleIssueScore` | **仅 QA**（硬伤仍归规则引擎，见红线） | — | — |
| MUSIQ aesthetic（独立 teacher，非 VLM） | aesthetic | `aesthetic` | MSE/Huber |
| CLIP/DINOv2 embedding（独立 teacher） | scene/backbone 投影 | — | cosine |
| 人工星级 | persona | `personaScore` | weighted BCE + pairwise |

> 标「仅 QA」的字段照常由 teacher 产出、进 QA 报告，但**不建 student head、不进 ONNX 输出**——避免给小模型塞它学不动也用不上的目标。若后续要启用，再单独加头并扩 `ProHeadScores`。

### Phase 5：Pro A/B 评估

使用现有 `bench-pro-persona.mjs` 扩展为：

`tools/ai-lab/bench-pro-semantic-student.mjs`

对比组：

- `current-production-rules`
- `ratio-aware-rules`
- `pro-persona-v1`
- `pro-semantic-v2-persona-only`
- `pro-semantic-v2-semantic-only`
- `pro-semantic-v2-fused`
- `pro-semantic-v2-face-guard`
- `pro-semantic-v2-flat-scalar`（**消融对照**：teacher 只给扁平标量、不带 reasoningTrace/faceRegionVerdicts 接地，其余训练一致）

> **接地标签 vs 纯标量消融（回答「看懂内容是否真有增量」）**：`fused` 用带区域接地的标签训练，`flat-scalar` 用同一 teacher、同样的图、但 prompt 退化为「只给标量分、不要推理过程」产出的标签训练。若 `fused` 在 RQ2（空镜/大景召回）、RQ3（假脸误报）上**显著优于** `flat-scalar`，才证明「让 teacher 看懂内容再给分」带来了真实增量；若两者持平，说明价值来自「有 VLM teacher」本身，与是否接地无关——这一结论必须写进 `production-recommendation.md`。

比例：

- `38%`
- `45%`
- `50%`
- `60%`

主指标：

- 召回率按各数据集口径分别报：**G 盘三组按 `rating>=3`，相机扩展集等按 `rating>=1`**，禁止混成一个平均阈值。
- 4/5 星覆盖率。
- 负样本混入率。
- 重复污染：正式重复组多选必须保持 `0` 或接近 `0`。
- blocked / hard issue picked 必须为 `0`。
- 场景分层指标：人像、合照、空镜、大景、纪实分别报。
- 假脸误报率：轮胎/圆形物体/海报等误判为人脸的比例。

性能指标：

- DirectML batch=1 / batch=8 单图平均耗时。
- CPU fallback batch=1 单图平均耗时。
- 模型包体。
- 峰值内存/显存。
- 坏图单图 error，不挂整批。

### Phase 6：生产门槛

进入 Pro gated ranking 的条件：

- 任一低比例 `38% / 45% / 50%` 召回提升 `>= 5%`，或 4/5 星覆盖提升 `>= 8%`。
- 负样本混入率不比 baseline 恶化超过 `2%`。
- 重复污染不恶化。
- blocked picked 为 `0`。
- 假脸误报率下降，或至少不高于现有规则。
- DirectML / CPU fallback 性能可接受，不能比 Pro V1 慢到不可用。

不达标时：

- 不进入默认 Pro ranking。
- 保留 teacher 标签和训练报告。
- 分析失败原因：teacher 不稳定、student 容量不足、标签口径不一致、场景偏置、量化损伤。

## 任务拆解

### Task A：技能与研究材料

- [x] 安装 `research`
- [x] 安装 `research-deep`
- [x] 用 deep research 路线梳理 CVPR 2026 / VLM / teacher distillation 依据
- [x] 产出本任务文档

### Task B：Semantic Teacher 数据 schema

- [ ] 新增 `tools/pro-train/semantic_teacher_schema.py`
- [ ] 新增 JSON schema 校验脚本（含 `reasoningTrace` / `faceRegionVerdicts` 必填校验）
- [ ] 新增 teacher prompt 模板（强制先推理后给分，读原图）
- [ ] 输出 80 张 smoke 样本列表

### Task B2：量化/嵌入 teacher 特征（Phase 2.5，补 Phase 3 loss 的输入）

- [ ] 新增 `tools/pro-train/build_quality_teacher_features.py`，产 `teacher-camera.npz` / `teacher-audit3groups.npz`（`musiq_tech/musiq_aes/clip[512]`）
- [ ] **DINOv2 已定启用**：生成 `dino[768]` 并接上 `L_embedding`（缺 `dino[768]` 即 Phase 2.5 未完成）
- [ ] 这些特征跑 384（与 student 对齐），与 VLM teacher 跑原图分两条链路

### Task C：Teacher runner

- [ ] 新增 `tools/pro-train/run_semantic_teacher.py`
- [ ] **读高分辨率原图**（非 384 预览），输出含 reasoningTrace/faceRegionVerdicts
- [ ] 支持 Qwen2.5-VL 本地模型
- [ ] 支持 InternVL3 本地模型
- [ ] 支持 resume、失败重试、JSON 修复、schema 校验
- [ ] 支持 `--flat-scalar` 模式（退化 prompt，产消融对照标签）
- [ ] 所有缓存写入 `/data/FrameCullModelLab/cache`

### Task D：Teacher QA

- [ ] 新增 `tools/pro-train/audit_semantic_teacher.py`
- [ ] 输出 scene 分布、分数分布、uncertain 样本、高冲突样本
- [ ] 导出人工复查 HTML 或 CSV

### Task E：Student V2 训练

- [ ] 扩展 `train_distill_backbone.py`，接入 semantic teacher labels 与 Phase 2.5 的 npz 特征
- [ ] 扩展 `train_persona_head.py`，支持语义多头和 ranking loss；**按映射表建头，不建「仅 QA」字段的头**
- [ ] 星级阈值按数据集分别落地（**G 盘三组 `>=3`，相机扩展集等 `>=1`**；改 `train_persona_head.py` 第 118 行 audit3groups 分支），各自 `k` 值写进 manifest
- [ ] 按 scene-balanced split 训练
- [ ] 输出训练报告和 feature importance / ablation

### Task F：ONNX / INT8

- [ ] 扩展 `export_pro_onnx.py`
- [ ] 扩展 `compare_onnx_quant.py`
- [ ] manifest 记录 semantic schema version、teacher model、训练数据 hash

### Task G：Pro bench

- [ ] 新增 `bench-pro-semantic-student.mjs`
- [ ] 输出 `summary.md`
- [ ] 输出 `metrics-by-ratio.csv`
- [ ] 输出 `metrics-by-scene.csv`
- [ ] 输出 `false-negatives-by-ratio.csv`
- [ ] 输出 `duplicate-pollution-by-ratio.csv`
- [ ] 输出 `false-face-samples.csv`
- [ ] 输出 `pro-infer-latency.csv`

### Task H：产品接入决策

- [ ] 若达标，新增 Pro-only 实验开关
- [ ] 不改 Flash
- [ ] 不改变硬伤门禁
- [ ] 不改变重复组非代表抑制
- [ ] 不把 teacher 模型打包进客户端

## 服务器执行目录

```text
/data/FrameCullModelLab/
  incoming/
    raw-audit-previews/
    camera-previews-384/
    camera-labels/
  cache/
    huggingface/
    torch/
    pip/
  features/
    teacher/
    semantic-teacher/
  outputs/
    semantic-teacher-lab/
    distill/
    persona/
    semantic-student-v2/
  workspace/
    tools/
      pro-train/
      ai-lab/
    output/
      ai-bench/
```

## 初始命令草案

### 数据审计

```bash
cd /data/FrameCullModelLab/workspace
python tools/pro-train/audit_semantic_inputs.py \
  --gdrive-previews /data/FrameCullModelLab/incoming/raw-audit-previews \
  --gdrive-labels /data/FrameCullModelLab/incoming/raw-audit-previews/labels.json \
  --camera-previews /data/FrameCullModelLab/incoming/camera-previews-384 \
  --camera-labels /data/FrameCullModelLab/incoming/camera-labels/camera-labels-final.json \
  --out /data/FrameCullModelLab/outputs/semantic-teacher-lab/data-audit
```

### teacher smoke

```bash
python tools/pro-train/run_semantic_teacher.py \
  --model qwen2.5-vl-7b \
  --input /data/FrameCullModelLab/outputs/semantic-teacher-lab/smoke-list.json \
  --schema tools/pro-train/semantic_teacher_schema.json \
  --out /data/FrameCullModelLab/features/semantic-teacher/smoke-qwen2.5-vl.jsonl \
  --cache /data/FrameCullModelLab/cache
```

### 全量 teacher

```bash
python tools/pro-train/run_semantic_teacher.py \
  --model qwen2.5-vl-7b \
  --input /data/FrameCullModelLab/outputs/semantic-teacher-lab/all-images.json \
  --schema tools/pro-train/semantic_teacher_schema.json \
  --out /data/FrameCullModelLab/features/semantic-teacher/semantic-teacher-v1.jsonl \
  --cache /data/FrameCullModelLab/cache \
  --resume
```

### Student V2 训练

```bash
python tools/pro-train/train_semantic_student.py \
  --backbone convnext_tiny \
  --teacher /data/FrameCullModelLab/features/semantic-teacher/semantic-teacher-v1.jsonl \
  --labels /data/FrameCullModelLab/incoming/camera-labels/camera-labels-final.json \
  --audit-labels /data/FrameCullModelLab/incoming/raw-audit-previews/labels.json \
  --out /data/FrameCullModelLab/outputs/semantic-student-v2/convnext_tiny \
  --epochs 30 \
  --batch 64
```

### 导出与评估

```bash
python tools/pro-train/export_pro_onnx.py \
  --student /data/FrameCullModelLab/outputs/semantic-student-v2/convnext_tiny/student-best.pt \
  --persona /data/FrameCullModelLab/outputs/semantic-student-v2/convnext_tiny/persona-best.pt \
  --out output/pro-models/semantic_student_v2_convnext_int8 \
  --name framecull-pro-semantic-v2

node tools/ai-lab/bench-pro-semantic-student.mjs \
  --manifest output/pro-models/semantic_student_v2_convnext_int8/manifest.int8.json \
  --output output/ai-bench/pro-semantic-student-eval \
  --ratios 0.38,0.45,0.50,0.60
```

## 输出文件要求

最终实验必须输出：

- `summary.md`
- `teacher-quality-report.md`
- `teacher-license-clearance.md`（teacher license 结论，全量标注前产）
- `metrics-by-ratio.csv`
- `metrics-by-scene.csv`
- `false-negatives-by-ratio.csv`
- `duplicate-pollution-by-ratio.csv`
- `false-face-samples.csv`
- `grounded-vs-flat-ablation.md`（接地标签 vs 纯标量对照，回答「让打分看懂内容是否真有增量」）
- `pro-infer-latency.csv`
- `selected-config-by-ratio.json`
- `selected-model-manifest.json`
- `production-recommendation.md`

## 风险与应对

| 风险 | 表现 | 应对 |
|---|---|---|
| teacher 幻觉 | JSON 看似合理但误判画面 | 多 teacher 对照 + 人工抽样 + uncertain 字段，不把 teacher 当真值。 |
| 语义 teacher 太慢 | 全量标注耗时长 | 离线一次性跑，支持 resume，先 smoke 再全量。 |
| student 学不到 teacher | SRCC/PLCC 低 | 增大 head、换 backbone、降低 teacher 任务复杂度。 |
| 学到 teacher 但筛片无收益 | teacher 保真高但召回不升 | 增强 persona fine-tune，调整 ranking loss，增加场景分层训练。 |
| 相机集标签口径偏差 | 1 星可用、0 星淘汰与 G 盘口径不同 | 分数据集报告，不做一个平均数掩盖问题。 |
| 假脸仍高 | 轮胎/圆形物体被当脸 | 增加 faceValidity head 和 hard negative samples。 |
| 量化损伤 | INT8 分数漂移 | 保留 FP32 对照，量化差异超阈值时不上 INT8。 |
| Pro 速度慢 | DirectML 单图耗时过长 | batch、预处理流水线、ConvNeXt 优先，ViT 只做候选。 |

## 验收门槛

实验完成的最低验收：

- teacher 全量 JSONL 生成完成，schema 校验通过。
- Student V2 至少一个 backbone 完成训练。
- ONNX FP32 和 INT8 导出成功。
- Pro 原生推理能读新 manifest 并返回新增多头分数。
- 38/45/50/60 四档评估报告完整。
- 结果按数据集和场景分层，不只给总平均。
- 明确给出是否进入 Pro gated ranking 的建议。

进入产品候选的门槛：

- 低比例召回提升达到 `>= 5%`，或 4/5 星覆盖提升达到 `>= 8%`。
- 负样本混入率不明显恶化。
- 假脸误判下降或不恶化。
- 重复污染不反弹。
- 硬伤片不被救回。
- 模型包体和速度符合 Pro 定位。

## 下一轮执行 Prompt

```text
Implement FrameCull Pro Semantic Teacher Lab v1.

Use the plan in docs/GOAL_pro_semantic_teacher_lab.md as the authority. Goal: make the Pro aesthetic/culling scores "understand picture content" by distilling a content-understanding VLM teacher into a small local student. Build a server-side semantic teacher pipeline under /data/FrameCullModelLab that uses local open-source VLM teachers such as Qwen2.5-VL and optionally InternVL3 to generate structured semantic labels for the G-drive validation set and camera dataset. Do not upload RAW or private photos to third-party cloud APIs.

HARDWARE FEASIBILITY DRIVES MODEL SELECTION: the teacher must run offline on a single 5090 (32GB) — slow/quantized is fine, but no multi-GPU or cloud dependency. The distilled student must run on a 6GB consumer discrete GPU (GTX1660/RTX2060/3050 class) via DirectML, with CPU fallback. Prefer ConvNeXt-Tiny as the student backbone (DeiT/ViT-Tiny only as a candidate if it fits the 6GB + DirectML/CoreML constraint). Do not pick models based on any single paper's paradigm.

Create schema-validated JSONL teacher outputs. Crucially, the teacher must produce GROUNDED, CONTENT-AWARE labels, not flat scalars: each record needs a `reasoningTrace` (region -> visual evidence -> supports/rejects keep) from which `semanticKeepScore` is aggregated, and `faceRegionVerdicts` (per suspected-face region: real-or-fake judgment WITH visual evidence) from which `faceValidityScore`/`falseFaceRisk` are derived. This is how the scores actually "see" content rather than guessing from pixels. The teacher must read HIGH-RESOLUTION ORIGINALS, not the 384px previews (384 is the student input size only). Ratings must be used only as training/evaluation labels, never as teacher input or ranking features.

Before full annotation, clear teacher license (output `teacher-license-clearance.md`): distilled labels bake into the shipped student weights, so the teacher's license must permit training-on-outputs and commercial redistribution. Also generate the quality/embedding teacher features — MUSIQ, CLIP, and DINOv2 `dino[768]` (DINOv2 is enabled: `L_embedding` is kept, so `dino[768]` MUST be generated; missing it means Phase 2.5 is incomplete) — so Phase 3 losses have inputs. Apply the per-dataset rating threshold: positive = `rating>=3` for the G-drive set (`audit3groups`/`raw-audit-previews`) ONLY, `rating>=1` for all other datasets (camera set etc.); fix `train_persona_head.py` line 118 (audit3groups branch) accordingly and report recall per dataset at its own k, never as one averaged threshold.

Then train a Pro Student V2 multi-head model using the existing shared-backbone architecture (aesthetic head is the primary objective; scene/persona/semantic-keep/face-validity are supporting heads). Build only the heads in the teacher->head->ProHeadScores mapping table; do not build heads for QA-only fields. Keep Flash fully isolated. Export FP32 and INT8 ONNX manifests compatible with the existing pro_infer layer, extend ProHeadScores only behind Pro gates, and evaluate 38%, 45%, 50%, and 60% AI Pick ratios. Include a `flat-scalar` ablation arm (same teacher, grounding disabled) to prove content-aware grounded labels add real value over plain VLM scoring.

Final output must include teacher-quality-report.md, teacher-license-clearance.md, summary.md, metrics-by-ratio.csv, metrics-by-scene.csv, false-negatives-by-ratio.csv, duplicate-pollution-by-ratio.csv, false-face-samples.csv, grounded-vs-flat-ablation.md, pro-infer-latency.csv, selected-config-by-ratio.json, selected-model-manifest.json, and production-recommendation.md. Recommend product integration only if recall/4-5-star coverage improves without increasing hard issue picks, duplicate pollution, or false-face errors.
```
