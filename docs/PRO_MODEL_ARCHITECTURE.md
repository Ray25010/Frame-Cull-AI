# FrameCull Pro 模型架构与部署设计

> 本文档规划 Pro 版本的本地 AI 模型架构：用 MUSIQ / CLIP 蒸馏出可本地部署的小模型，采用「共享 backbone + 多任务头 + 可下发场景头」的统一结构，并定义独显推理链路与最低配置。

## 0. 一句话结论

不要做三个独立模型，做**一个共享 backbone + 多个轻量头**。单张 GPU 上多个独立模型不会真并行，只会争抢显存和调度、重复做特征提取，净亏。统一结构跑一次特征提取，后面挂多少个头都几乎不增加成本，而且新场景头可以「冻结主干、单独训练、单独下发」。

---

## 1. 名词通俗解释

### 1.1 什么是 backbone（主干网络）

把一张图变成「机器能理解的特征向量」的那部分网络，就是 backbone。

打个比方：backbone 像一个**资深看图的眼睛 + 大脑前半段**。它把原始像素逐层抽象成「这里有边缘、那里有人脸、整体偏暗、构图居中」这类高层特征（一串数字，叫 feature/embedding）。它**不直接给结论**，只负责「看懂这张图长什么样」。

后面的「头（head）」才负责下结论：技术头说「清晰度 78 分」，美学头说「观感 65 分」，场景头说「这是婚礼」。

关键点：**最重、最耗算力和显存的就是 backbone**。头都很轻（几层全连接）。所以多个任务共用一个 backbone，等于「看一次图，回答多个问题」，这就是省的地方。

### 1.2 为什么这能解决「并发打架」

- 三个独立模型 = 三个 backbone = 看三遍图 = 三倍重活 + 三份显存
- 一个共享 backbone = 看一遍图 = 多个头分别回答 = 重活只做一次

GPU 对计算密集的 backbone 前向是**串行排队**执行的，开三个模型只是时间片轮转，并不会变快，反而因显存和缓存争抢更慢。真正能并行的只有「CPU 预处理 / 磁盘 IO」和「GPU 计算」的流水线重叠，这和模型数量无关。

---

## 2. 推荐架构：共享 backbone + 多头

```
                       ┌─────────────────────────────┐
   原图 (单分辨率输入)  →  │   共享 Backbone（重，跑一次）  │  → 特征向量 feature
                       └─────────────────────────────┘
                                      │
        ┌──────────────┬──────────────┼──────────────┬─────────────────┐
        ▼              ▼              ▼              ▼                 ▼
   ┌─────────┐    ┌─────────┐    ┌─────────┐    ┌──────────┐     ┌──────────────┐
   │ 技术质量头 │   │  美学头  │    │ 场景分类头 │   │ 个性筛选头 │ …  │ 个性筛选头(N) │
   │(KonIQ-   │   │(AVA-    │    │(CLIP 语义)│   │  婚礼      │     │  会议活动     │
   │ MUSIQ 蒸馏)│  │ MUSIQ蒸馏)│   │           │   │           │     │              │
   └─────────┘    └─────────┘    └─────────┘    └──────────┘     └──────────────┘
        │              │              │              │                 │
        ▼              ▼              ▼              └──── 由场景头路由自动启用对应个性头
   接入现有 photoScoring 的分量    feed classifyScoreScene
```

### 2.1 各头职责

| 头 | 教师 / 来源 | 输出 | 接入点 |
|---|---|---|---|
| 技术质量头 | KonIQ / SPAQ-MUSIQ | 技术失真分（模糊/噪点/压缩） | `photoScoring` 的 `TECHNICAL_QUALITY`（或继续交规则引擎，见 §2.3） |
| 美学头 | AVA-MUSIQ | 美学观感分 | `AESTHETIC_QUALITY`，替换现 `calibratedAestheticModelScore` |
| 场景分类头 | CLIP 语义 embedding | 场景类别 + 置信度 | `classifyScoreScene`，并做个性头路由 |
| 个性筛选头 | 各场景人工筛片标签微调 | 该场景下的「值得留」偏好分 | AI Pick 排序（`aiPickRankScore`） |

### 2.2 场景头做路由（关键设计）

一次前向里，场景头先判定类别（婚礼/户外人像/会议…），系统据此**自动启用对应个性头**。用户无需手动选场景，也避免同时跑所有个性头。个性头本身极轻，留着不用也几乎零成本，但路由能让「这场是婚礼 → 用婚礼偏好打分」自动发生。

### 2.3 分辨率冲突——本设计唯一的真实代价

技术失真检测对分辨率高度敏感（降采样会把模糊「洗掉」），而美学/场景不敏感。共享 backbone 用同一输入，必然要折中。两条路线：

- **方案 A**：折中分辨率（384 或 512），技术头也走 backbone。简单，但技术头精度受限。
- **方案 B（已定）**：学习型模型只负责美学 + 场景 + 个性偏好这些「软」判断；**硬技术失真（失焦/噪点/曝光）继续交给现有规则引擎**（Sobel/Laplacian/分位数那套，在高分辨率原图上算）。

**采用方案 B**：既绕开分辨率冲突，又保住硬伤判定的可解释性和可控性。黑盒分数不该接管「这张是不是废片」这种需要解释的决策——规则引擎能讲清「为什么判废片」，模型只在它的强项（美学/场景/偏好）上发力，各用各的分辨率。

---

## 3. 个性头：预训练下发模式

你们已确定个性头**预训练好、随版本下发**（非用户本地训练）。这条路的工程收益：

- **训练成本低**：冻结 backbone，只训练几层头，小数据集 + 小算力即可。
- **发布轻**：新场景只发一个几 MB 的头权重文件，不重训主干、不重发整模型。
- **可热更新**：头权重和主干解耦，能独立做版本管理（见下）。
- **可扩展**：以后加「宠物 / 美食 / 旅拍」只是再训一个头。

### 3.1 头权重版本管理建议

```
models/pro/
  backbone_v1.onnx          # 主干，更新频率低
  heads/
    technical_v1.onnx
    aesthetic_v1.onnx
    scene_v2.onnx           # 场景头可独立迭代
    persona_wedding_v3.onnx # 个性头独立版本号
    persona_outdoor_v1.onnx
    persona_event_v1.onnx
  manifest.json             # 记录 backbone 版本与各头兼容性
```

`manifest.json` 标注每个头兼容哪个 backbone 版本——backbone 一旦升级，旧头需重训或标记不兼容。这是共享架构必须管好的契约。

---

## 4. 独显推理链路：CUDA vs DirectML

### 4.1 速度对比

在 NVIDIA 卡上 **CUDA 通常比 DirectML 快 20%~50%**（视模型/算子而定），但不是数量级碾压。原因：

- **CUDA + cuDNN/TensorRT**：NVIDIA 自家深度优化，算子融合、kernel 调度成熟。
- **DirectML**：走 DirectX 通用计算抽象，多一层翻译；为兼容 N/A/Intel 卡牺牲了针对性优化。

| 维度 | CUDA EP | DirectML EP |
|---|---|---|
| N 卡速度 | 最快 | 慢 20%~50% |
| 显卡兼容 | 仅 NVIDIA | NVIDIA / AMD / Intel 通吃 |
| 平台 | 跨平台（需 CUDA 驱动） | Windows 原生 |
| 部署复杂度 | 需匹配 CUDA/cuDNN 版本，较重 | 随 Windows，较轻 |
| 适合 | 追求极致性能的 N 卡用户 | 覆盖最广用户面 |

### 4.2 推荐：多 EP 策略（含跨平台）

CUDA/DirectML 都只限 Windows——CUDA 仅 N 卡，DirectML 仅 Windows。Mac 必须用完全不同的后端。**同一个 ONNX 模型文件**在不同平台只换 EP，不需要为某个平台单独训模型。启动时探测平台和硬件，按下表选 EP：

| 平台 | 推荐 EP | 用什么硬件 | 备注 |
|---|---|---|---|
| Windows + N 卡 | **CUDA** | NVIDIA GPU | 最快，主路径 |
| Windows + A/Intel 卡 | **DirectML** | 任意 GPU | 兜底覆盖 |
| **macOS (Apple Silicon)** | **CoreML EP** | GPU + ANE 神经引擎 | onnxruntime 原生支持 |
| macOS (Intel) | CPU EP | — | 不做 GPU 优化 |
| 全平台最终兜底 | CPU EP | — | 慢但能跑 |

```
启动探测逻辑：
  macOS + Apple Silicon → CoreML EP
  macOS + Intel         → CPU EP
  Windows + NVIDIA      → CUDA EP
  Windows + 其他 GPU    → DirectML EP
  以上全部失败          → CPU EP
```

> **Apple Silicon 是统一内存**：CPU/GPU 共享同一块内存，没有独立 VRAM 限制。8GB 的 M 芯片即可跑得不错，比 Windows 独显的显存约束更宽松。

### 4.3 平台支持矩阵（已定稿）

为控制工程量，按 edition 分别定义支持范围：

| 平台 / 硬件 | Flash | Pro |
|---|---|---|
| Windows + N 卡 | ✅ wasm | ✅ CUDA 加速 |
| Windows + A/Intel 卡 | ✅ wasm | ✅ DirectML 加速 |
| macOS Apple Silicon | ✅ wasm | ✅ CoreML 加速 |
| macOS Intel | ✅ wasm (CPU) | ❌ 不支持 |

**决策依据**：

- **Flash 全平台覆盖**：走 onnxruntime-web wasm，模型轻，CPU 也能跑，所有平台（含 Intel Mac）一视同仁。
- **Pro 只支持 Apple Silicon + Windows 独显**：Pro 的重模型需要 GPU 加速才有可用体验；**Intel Mac 无可用 GPU 加速路径，纯 CPU 跑大批量会卡到不可用**，故不纳入 Pro。
- Intel Mac 的代码增量几乎为零（落 CPU 兜底即可），真正成本在 universal binary 打包和每版真机回归——这些成本由 Flash 承担一次即可，Pro 不再为它付费。

### 4.4 与现有 Tauri 架构的关系

- **Flash 版**：维持现状，onnxruntime-web **wasm**，不依赖独显，全平台轻量开箱。
- **Pro 版**：走**原生 onnxruntime（CUDA / DirectML / CoreML EP）**，通过 Rust 端进程内绑定（`ort` crate）调用，才能真正吃到 GPU 算力。进程模型与对接细节见 §10.3（已定为进程内绑定，非 sidecar）。

这是两套独立推理层，需在 edition 分线时就隔离清楚（你们已有 `FRAMECULL_EDITION` 机制，正好挂载不同推理后端）。

**Mac 打包注意**：Apple Silicon 单架构出包即可（Pro 不管 Intel Mac，省去 universal binary 负担）；仍需处理 Apple 签名 / 公证流程。Flash 若要覆盖 Intel Mac 则需 universal binary。

---

## 5. backbone 选型对比（通俗版）

学生 backbone 的选型，核心权衡是 **精度 vs 速度/显存 vs 部署友好度**。三个主流候选：

| backbone | 通俗理解 | 优点 | 缺点 | 适合 |
|---|---|---|---|---|
| **EfficientNet-lite** | 专为端侧设计的「省电小钢炮」 | 量化友好、ONNX 导出干净、wasm/移动端成熟 | 精度上限略低于大模型 | Flash 复用 / Pro 求稳 |
| **ConvNeXt-tiny** | 现代卷积网，精度接近 ViT 但更好部署 | 精度高、卷积结构对各 EP 友好、量化稳 | 比 lite 系重一些 | Pro 主推 |
| **小 ViT（如 ViT-Tiny/DeiT-Tiny）** | Transformer，全局视野强 | 美学/语义任务表现好、和 CLIP 蒸馏天然契合 | 显存/算子对量化和 wasm 略不友好、低分辨率需注意 | Pro 偏美学/语义 |

**选型方法（已定：不预先拍死，双候选 A/B 对比）**：

考虑到 Pro 的核心卖点包含美学与场景语义（要蒸 CLIP，语义权重不低），**小 ViT 的精度收益可能值得**——ViT 对全局构图、语义的感知通常强于同级卷积网。因此不靠拍脑袋选，而是各蒸一版、用双指标对比：

- **候选 A：ConvNeXt-tiny** —— 风险最低的基线。卷积算子各 EP 都吃得下，量化稳，跨平台一致性好。
- **候选 B：小 ViT（DeiT-Tiny / ViT-Tiny）** —— 精度/语义上限可能更高，和 CLIP 蒸馏天然契合，但需验证 CoreML 算子回退与延迟。

对比口径：在人工验证集上跑前面定义的双指标（蒸馏保真度 SRCC/PLCC + 筛片实用性 AUC/precision@k），并在 Apple Silicon 真机量两者的 CoreML 回退比例和单图延迟。**数据说话，不靠先验。**

> 排除项：MUSIQ 的多尺度 Transformer（端侧延迟不可接受，学生固定单分辨率输入）；Swin-Tiny（算子更冷门，跨 EP 风险高于普通 ViT）。EfficientNet-lite / MobileNet 系留作「下沉弱硬件或与 Flash 共用主干」的备选。

#### 最小对比实验清单

1. 各蒸一版 A / B，相同教师、相同蒸馏集、相同输入分辨率。
2. 在隔离验证集上量：SRCC、PLCC（vs 教师）；AUC、precision@k（vs 真实 keep/reject），**按场景分别报**。
3. int8 量化后复测精度掉多少。
4. Apple Silicon 真机：CoreML 算子回退比例、单图延迟、batch 吞吐。
5. Windows 6GB 卡（如 3050）真机：显存占用、延迟、吞吐。

> **CoreML 算子覆盖是 Mac 端的关键约束**：CoreML EP 不支持全部 ONNX 算子，遇到不支持的会回退到 CPU 跑那一段，拖慢整体。卷积网（ConvNeXt / EfficientNet）算子覆盖好、风险低；小 ViT 的部分 Transformer 算子在 CoreML 上风险略高——这正是上面实验第 4 步要量的。若 B 的精度收益不足以抵消 Mac 端的回退代价，则回落 A。

---

## 6. 最低性能配置（Pro min-spec）

Pro 仅支持 **Windows 独显 + Apple Silicon** 两类硬件，分别看约束。

### 6.1 Windows 独显

关键约束是 **VRAM，不是算力**。共享 backbone + 多头，fp16/int8 后并不大。

| 档位 | 目标显卡示例 | VRAM | 预期体验 |
|---|---|---|---|
| 最低 | GTX 1660 / RTX 2060 / 3050 | **6 GB** | 可用，batch 偏小 |
| 推荐 | RTX 3060 / 4060 | 8 GB | 流畅，整场批处理 |
| 理想 | RTX 4070+ | 12 GB+ | 大 batch，高吞吐 |

> ⚠️ 训练在 5090（32GB）上做，**不要用 5090 规格倒推 min-spec**。盯 6GB 这一档能覆盖一大批存量用户；再往上抬会砍掉很多人。

### 6.2 Apple Silicon

统一内存，无独立 VRAM 约束，门槛更低：

| 档位 | 芯片示例 | 统一内存 | 预期体验 |
|---|---|---|---|
| 最低 | M1 / M2 | 8 GB | 可用，CoreML 调 GPU+ANE |
| 推荐 | M1 Pro / M2 Pro 及以上 | 16 GB+ | 流畅，整场批处理 |

> Intel Mac 不在 Pro 支持范围（见 §4.3），无需为其定 min-spec。

**吞吐杠杆**：Pro 处理整场拍摄，务必做 **batch 推理**——共享 backbone 批量过图是最大的吞吐杠杆，远比「并发多模型」有效。CPU 预处理 / 磁盘读取与 GPU 计算做流水线重叠，进一步提速。

---

## 7. 蒸馏与验证要点（承接前期讨论）

### 7.1 蒸馏
- 软标签来自教师在你们大数据集上的打分，**蒸馏阶段无需人工标注**，且 in-domain 数据让学生特化到筛片场景。
- 多头蒸馏：技术头蒸 KonIQ-MUSIQ、美学头蒸 AVA-MUSIQ，**分头蒸馏避免把两种语义压成一个标量丢信息**。
- CLIP 走语义线（喂场景头），不要硬当质量分。

### 7.2 验证必须分两个独立指标
1. **蒸馏保真度**：学生 vs 教师分数的 SRCC / PLCC（学生学得像不像）。
2. **筛片实用性**：学生分数 vs 真实 keep/reject 的排序能力（AUC、precision@k，尤其 AI Pick top-k 命中率）。

常见情况是「保真度高、实用性一般」——说明问题在教师/任务定义，不在学生。**解法：蒸馏后用少量人工筛片标签做一轮微调（distill → fine-tune）**，让学生从「通用质量」偏移到「筛片偏好」。个性头本质就是这个微调的产物，按场景分别做。

> 验证集必须人工标注，且与蒸馏集严格隔离。

---

## 8. 待确认 / 下一步

- [ ] backbone 最终选型 → **方法已定：ConvNeXt-tiny (A) 与小 ViT (B) 双候选 A/B 对比，数据定夺**（见 §5）
- [x] ~~技术失真走方案 A 还是 B~~ → **已定：方案 B，硬技术失真交规则引擎，学习型模型只做软判断**
- [x] ~~CUDA / DirectML 是否采用双 EP 策略~~ → **已定：多 EP（CUDA/DirectML/CoreML）+ CPU 兜底**
- [x] ~~平台支持范围~~ → **已定：Flash 全平台覆盖；Pro 仅 Apple Silicon + Windows 独显，不支持 Intel Mac**
- [x] ~~首批个性头场景~~ → **已定：户外人像类（研学、户外活动），验证集占比约 85%**
- [x] ~~折中输入分辨率定档~~ → **已定：384**（理由见下）
- [x] ~~Pro 推理层进程模型与对接方案~~ → **已定：Rust 进程内嵌 `ort` crate（非 sidecar），多 EP + CPU 兜底，实现规格见 §10**
- [ ] 验证集随扩充补齐婚礼 / 会议活动等场景（当前仅户外人像可下结论）
- [ ] 执行 §5 最小对比实验，产出 A/B 选型报告
- [ ] 执行 §10 Pro 原生推理层（codex 实现，按 §10.9 验收）

> **分辨率定 384 的理由**：方案 B 已把最吃分辨率的技术失真（失焦/噪点/曝光）移交规则引擎在高分辨率原图上算，学习型模型只剩美学/场景/个性偏好这些对分辨率不敏感的任务。512 比 384 约多 1.78× 计算量与激活显存（ViT 因 attention 平方关系涨得更陡），收益却落在模型不负责的细粒度维度上，性价比低，且会挤压 6GB 独显 / M1 8GB 的 batch 吞吐。远景小脸属人脸检测（YuNet）与技术失真范畴，不归此模型，故不构成升 512 的理由。

确认后可进一步产出：损失函数与教师分数归一化设计、双指标评测脚本结构（Pro 原生推理层对接方案已在 §10 定稿）。

---

## 9. 验证集标签处理规范

当前验证集 5000 张，含星级与无星级，后续扩充。本节定义如何从中派生可靠的训练/验证标签。

### 9.1 标签来源与语义（已确认）

- **有星级 = keep（正样本）**：用户主动评了星，视为「值得留」。
- **无星级 = reject（负样本）**：**已确认是主动不给，非「还没评」**，因此可直接作负样本，无需推断。
- 星级数值（1–5）可作为**排序强度**：5 星 > 3 星 > 1 星 > 无星，用于 learning-to-rank 而不仅是二分类。

> ⚠️ 前提守住：必须确保集合内无「还没评」的样本混入。若后续扩充引入了未完成评星的批次，需先剔除或单独标记，否则会把「漏评」误当「主动弃」，污染负样本。

### 9.2 用途划分（防数据泄漏）

5000 张身兼两职，必须严格隔离：

| 用途 | 说明 | 隔离要求 |
|---|---|---|
| 个性头微调 | distill → fine-tune，让学生偏移到筛片偏好 | 训练子集 |
| 双指标验证 | 量蒸馏保真度 + 筛片实用性 | 验证子集，**绝不参与任何训练** |

- backbone 蒸馏**不用**这 5000 张——它用大数据集 + 教师软标签，所以 85% 户外人像的偏态**不会带偏主干**。
- 划分按**拍摄场次/相册**而非单张随机切，避免同一场连拍既进训练又进验证造成泄漏。

### 9.3 场景偏态的影响与纪律

验证集约 **85% 户外人像（研学、户外活动）**：

- **够用**：足以支撑首批「户外人像个性头」的训练与验证，与首发场景范围一致。
- **限制**：婚礼 / 会议活动等在有标注数据前**不能下效果结论**。
- **硬纪律**：验证报告**按场景分别报指标，禁止平均成一个总分**——85% 户外人像会把总分拉成「户外人像分」，掩盖其他场景的真实表现，形成误导。

### 9.4 推荐评测指标

| 指标 | 衡量什么 | 备注 |
|---|---|---|
| SRCC / PLCC | 学生 vs 教师分数一致性（蒸馏保真度） | 全局可报 |
| AUC | keep/reject 二分类区分力 | **按场景分报** |
| precision@k | top-k 命中真实 keep 的比例 | 对齐 AI Pick 场景，**按场景分报** |
| 排序相关（星级 vs 学生分） | 是否复现 5>3>1>无 的强度序 | learning-to-rank 用 |

### 9.5 扩充建议

随数据扩充，优先补齐**非户外人像场景**（婚礼、会议活动）以解锁对应个性头和验证结论，而非继续堆户外人像——后者边际收益已低。每个新场景达到足够样本量前，其个性头标记为「实验性」，不进正式下发。

---

## 10. Pro 原生推理层 + Tauri 对接实现规格（供执行 / 供审查）

> 本节是给执行方（codex）的**可落地、可验收**规格。审查方按 §10.9 验收清单逐条核。规格只描述 Pro 推理层的「接入边界、进程模型、接口契约、降级与隔离」，不涉及模型训练（见 §5/§7）。

### 10.1 目标与非目标

**目标**：Pro edition 下，把共享 backbone + 多头模型的推理放到 **Rust 端原生 onnxruntime**（CUDA / DirectML / CoreML EP + CPU 兜底），前端通过 Tauri command 调用，吃到 GPU 算力并支持 batch。

**非目标**（本轮不做，明确划线）：

- 不动 Flash 的 onnxruntime-web wasm 链路（`aiAnalyzer.worker.ts` / `peopleSplit.worker.ts` **一行不改**）。
- 不替换现有 YuNet 人脸检测、MediaPipe Landmarker、SFace、规则引擎——它们继续在 worker 里跑。Pro 推理层**只接管新的蒸馏多头模型**（美学/场景/个性偏好）。
- 不在本轮训练或转换真实模型；用一个占位 ONNX（输入 `[N,3,384,384]`、输出多头 dict）打通链路即可，模型替换是后续事。

### 10.2 现状边界（已核实，作为接入锚点）

- ONNX 推理现状：**全在前端 worker**，`onnxruntime-web/wasm`，`InferenceSession.create({ executionProviders: [backend] })`，backend 仅 `wasm`（`webgpu` 被 gate）。
- Rust 端：已有 `pro` feature（`Cargo.toml [features] pro = []`）、30 个 `#[tauri::command]`、完整 `#[cfg(feature = "pro")]` gate（现仅罩 RawTherapee 链路），**无任何 ONNX/ort 依赖**。
- edition 分流：前端 `IS_PRO_EDITION`（`src/utils/appInfo.ts`），构建走 `tauri:build:pro --features pro`。
- 接口现状：worker 经 `AiModelAssets`（`src/types.ts:291`）拿模型/wasm 候选路径；主线程经 `useAiCulling.ts` postMessage 驱动 worker。

### 10.3 进程模型：进程内绑定（已定，非 sidecar）

**决策：Rust 进程内嵌 `ort` crate（onnxruntime 官方 Rust 绑定），不开独立 sidecar 进程。**

理由：

- **零 IPC 拷贝大 buffer**：sidecar 要把每张图的像素或张量跨进程序列化传递，整场批处理代价高。进程内绑定直接在 Rust 堆上预处理 + 喂模型。
- **ort crate 原生支持多 EP**：CUDA / DirectML / CoreML / CPU 都是 feature flag，与本设计的多 EP 策略天然对齐。
- **生命周期简单**：session 随 App 状态（`tauri::State`）持有，无需管子进程崩溃重启、端口、心跳。

代价与兜底：进程内推理若 GPU 驱动崩溃会带崩主进程。**缓解**：EP 初始化与首次 warmup 包在 `catch_unwind` / `Result` 里，失败按 §10.6 降级链回落，不 panic 主进程。**若**真机回归发现某 EP 驱动稳定性差到必须隔离，再退化为 sidecar——但默认不做，避免过度工程。

### 10.4 模块与 feature gate 结构

新增 Rust 模块（全部 gate 在 `#[cfg(feature = "pro")]` 后），建议结构：

```
src-tauri/src/
  lib.rs                  # 现有；仅新增 pro 推理 command 的注册（invoke_handler）
  pro_infer/
    mod.rs                # pub use；#![cfg(feature = "pro")] 整模块 gate
    ep.rs                 # EP 探测与选择（§10.6）
    session.rs            # 模型加载、session 缓存、manifest 解析（§3.1）
    preprocess.rs         # 解码/resize 384/归一化，复用现有 image crate
    infer.rs              # batch 推理、多头输出解析
    types.rs              # 与前端共享的 serde 结构（§10.5）
```

`Cargo.toml` 新增（gate 在 pro feature，Flash 构建不引入）：

```toml
[features]
default = []
pro = ["dep:ort", "dep:ndarray"]

[dependencies]
ort = { version = "2", optional = true, default-features = false }
ndarray = { version = "0.16", optional = true }
```

> EP 的 Cargo feature 按目标平台条件启用：Windows 启 `cuda` + `directml`，macOS 启 `coreml`，全平台保底 CPU。具体 feature 名以 codex 选定的 `ort` 版本文档为准——**这是审查点，不是拍死项**。

### 10.5 接口契约（Tauri command + TS 类型）

前端在 `IS_PRO_EDITION` 时，不走 worker 的 wasm 美学模型，改 invoke 下列 command。**Flash 路径完全不碰这些 command。**

Rust 端（命名固定，便于审查对照）：

```rust
#[cfg(feature = "pro")]
#[tauri::command]
async fn pro_infer_init(state: State<'_, ProInferState>, manifest_path: String)
    -> Result<ProInferCapabilities, String>;
// 探测 EP、加载 backbone + 各头、warmup。返回实际生效的 EP 与已加载头列表。

#[cfg(feature = "pro")]
#[tauri::command]
async fn pro_infer_batch(state: State<'_, ProInferState>, req: ProBatchRequest)
    -> Result<ProBatchResponse, String>;
// 一批图片路径 → 多头分数。Rust 端自己解码+预处理+batch，不从前端收像素。
```

共享数据结构（Rust serde 与 TS interface 字段名一一对应）：

```ts
// src/types.ts 新增（与 Rust types.rs 对齐）
export interface ProInferCapabilities {
  activeEp: 'cuda' | 'directml' | 'coreml' | 'cpu';
  epFallbackChain: string[];      // 实际尝试顺序，审查降级逻辑用
  backboneVersion: string;        // 取自 manifest
  loadedHeads: string[];          // e.g. ['aesthetic_v1','scene_v2','persona_outdoor_v1']
  inputResolution: number;        // 必须 === 384
  warmupMs: number;
}

export interface ProBatchRequest {
  imagePaths: string[];           // 传路径而非像素，Rust 解码
  batchSize?: number;             // 缺省由 Rust 按 VRAM 档位决定
  heads?: string[];              // 缺省跑全部已加载头；场景头路由可后置
}

export interface ProHeadScores {
  imagePath: string;
  aesthetic?: number;             // 0..1，喂 calibratedAestheticModelScore 接入点
  sceneLabel?: string;
  sceneConfidence?: number;
  personaScore?: number;          // 经场景头路由后启用的个性头分
  error?: string;                 // 单图失败不挂全批
}

export interface ProBatchResponse {
  results: ProHeadScores[];
  ep: string;
  elapsedMs: number;
}
```

**接入点对齐 §2.1**：`aesthetic` 喂 `photoScoring.ts` 的 `calibratedAestheticModelScore`；`sceneLabel/sceneConfidence` 喂 `classifyScoreScene`；`personaScore` 喂 `aiPickRankScore`。本轮只要求打通 `aesthetic` 一条，其余字段先返回占位，接入由后续轮做——但**类型一次定全**，避免反复改契约。

### 10.6 EP 探测与降级链（按 §4.2 落地）

启动探测顺序固定，逐级 try，任一级初始化或 warmup 失败则回落下一级，最终 CPU 兜底**永不失败**：

```
macOS + Apple Silicon → CoreML → CPU
macOS + Intel         → CPU（Pro 不支持，仅防御性兜底，正常不该进 Pro）
Windows + NVIDIA      → CUDA → DirectML → CPU
Windows + 其他 GPU    → DirectML → CPU
```

要求：

- 每一级失败必须**记录原因**进 `epFallbackChain`，前端可见（审查时据此判断「为什么没吃到 CUDA」）。
- `activeEp` 必须反映**真实生效**的 EP，不能写「期望值」。
- CoreML 算子回退（§5 实验第 4 步）属正常现象，不算降级，但应在日志体现回退比例（若 ort 暴露该信息）。

### 10.7 图像输入与 batch（吞吐杠杆，对齐 §6）

- **Rust 端拥有预处理**：收路径 → 解码（复用现有 `image` crate / RAW 链路）→ resize 到 **384**（§8 已定）→ 归一化 → 组 batch 张量。不从前端传像素，避免跨边界拷贝。
- batch 大小按硬件档位（§6.1/§6.2）自适应：6GB 卡小 batch、12GB+ 大 batch；缺省值由 Rust 探测 VRAM 决定，前端可覆盖。
- CPU 预处理与 GPU 推理做流水线重叠（解码线程池 + 推理队列），这是 §6 强调的最大吞吐杠杆。

### 10.8 隔离纪律（审查重点）

- Flash 构建（`--features` 不含 pro）**不得编译进** `ort`/`ndarray`，产物体积与依赖树与现状一致——审查时 `cargo tree` 对比。
- 所有新代码 gate 在 `#[cfg(feature = "pro")]`，Flash `cargo build` 不触达 `pro_infer/`。
- 前端 Pro 推理调用 gate 在 `IS_PRO_EDITION` 后，Flash 运行时不 invoke 任何 `pro_infer_*` command（缺失时也不报错）。
- 不复用、不修改 worker 里的 wasm session 加载逻辑。

### 10.9 验收清单（审查方逐条核）

1. `pnpm tauri:build:flash` 成功，且 `cargo tree`（flash）**不含 ort/ndarray**。
2. `pnpm tauri:build:pro` 成功，含 `pro_infer` 模块与新 command 注册。
3. Windows N 卡真机：`pro_infer_init` 返回 `activeEp: 'cuda'`，`inputResolution: 384`；拔掉/伪造 CUDA 失败时回落 `directml`，`epFallbackChain` 记录原因。
4. Apple Silicon 真机：`activeEp: 'coreml'`，CoreML 算子回退比例有日志。
5. `pro_infer_batch` 对一批图返回每图 `aesthetic` 分；单图损坏只在该图 `error` 字段报错，不挂全批。
6. batch 吞吐 > 单图循环（同机对照），证明 batch 路径生效。
7. Flash 运行时无任何 `pro_infer_*` invoke；Pro 运行时美学分来自原生层而非 wasm NIMA。
8. 占位模型可一键替换为真实蒸馏模型（仅改 manifest + 模型文件，不改代码）。
9. EP/session 初始化失败不 panic 主进程，按降级链回落，最坏 CPU 可用。

> **审查口径**：1/2/7/8 是硬隔离与可替换性，必须全过；3/4/9 是跨平台与健壮性，按真机结果判；5/6 是功能与性能基线。任一隔离项（1/2/7）不过即打回。
