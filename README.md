<div align="center">
  <img src="docs/assets/framecull-logo.png" alt="FrameCull AI logo" width="138" />

  <h1>FrameCull AI</h1>

  <p>
    <strong>本地 AI 筛片、图库整理工作台</strong><br />
    <strong>Local AI photo culling and library cleanup workspace</strong>
  </p>

  <p>
    <a href="#中文">中文</a> ·
    <a href="#english">English</a> ·
    <a href="https://github.com/Ray25010/Frame-Cull-AI/releases">Download</a> ·
    <a href="https://www.kdocs.cn/l/ckvgLtjq13lO">Flash 教程</a> ·
    <a href="https://www.kdocs.cn/l/ck6O3N1pAKlA">Pro 教程</a>
  </p>

  <p>
    <img alt="Release" src="https://img.shields.io/badge/release-v0.1.6_prerelease-2ea8ff" />
    <img alt="Windows" src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078d4" />
    <img alt="macOS" src="https://img.shields.io/badge/macOS-Apple%20Silicon%20%2F%20Intel-000000" />
    <img alt="Local AI" src="https://img.shields.io/badge/AI-local%20first-10b981" />
    <img alt="Flash" src="https://img.shields.io/badge/edition-Flash-f59e0b" />
    <img alt="Pro" src="https://img.shields.io/badge/edition-Pro-8b5cf6" />
  </p>
</div>

---

## 中文

FrameCull AI 是一款为拍摄后期选片和大量图库管理而设计的本地 AI 筛片软件。它结合多类视觉识别算法与自训练美学模型，可以在人像、风光、活动拍摄等场景中，帮助你更快挑出值得保留的好片。

除了 AI 精选，FrameCull AI 还支持人物分片、连拍重复选优、合照闭眼检测、RAW 自动曝光、LUT 监看、星级注入等功能，尽量把摄影后期里最繁琐的整理流程变得更轻松。

Flash 版本轻量快速，可在核显机型上流畅运行；Pro 版本则提供更完整的 RAW 监看能力、更丰富的扩展功能，以及更强的自训练 AI 筛选模型。

### ✨ 两个版本

| 版本 | 适合谁 | 主要特点 |
| --- | --- | --- |
| ⚡ **FrameCull AI Flash** | 想要轻量、快速、本地筛片和图库整理的用户 | 安装包更小，启动快，切图快，支持本地 AI 筛片、人物分片、重复照片清理 |
| 🧠 **FrameCull AI Pro** | 需要更强 AI 精选、RAW 曝光预览和专业工作流的用户 | 自训练蒸馏 AI 引擎、Pro persona 排序、RAW 监看、自动曝光预览、LUT 预览 |

简单说：**Flash 更轻，Pro 更强。**  
如果你主要看 JPG / RAW 内嵌预览并追求速度，选 Flash；如果你需要 Pro AI 引擎、RAW 自动曝光预览和 LUT 监看，选 Pro。

### 📦 下载


#### Windows

- [Flash x64 EXE](https://github.com/Ray25010/Frame-Cull-AI/releases/download/flash-ui-0.1.6-run-32216774744/FrameCull-Flash-Windows-x64-FrameCull.AI.Flash_0.1.6_x64-setup.exe) · [Flash x64 MSI](https://github.com/Ray25010/Frame-Cull-AI/releases/download/flash-ui-0.1.6-run-32216774744/FrameCull-Flash-Windows-x64-FrameCull.AI.Flash_0.1.6_x64_en-US.msi)
- [Pro x64 EXE](https://github.com/Ray25010/Frame-Cull-AI/releases/download/pro-ui-0.1.6-run-32216774744/FrameCull-Pro-Windows-x64-FrameCull.AI.Pro_0.1.6_x64-setup.exe) · [Pro x64 MSI](https://github.com/Ray25010/Frame-Cull-AI/releases/download/pro-ui-0.1.6-run-32216774744/FrameCull-Pro-Windows-x64-FrameCull.AI.Pro_0.1.6_x64_en-US.msi)

#### macOS

- [Flash Apple Silicon arm64](https://github.com/Ray25010/Frame-Cull-AI/releases/download/flash-ui-0.1.6-run-32216774744/FrameCull-Flash-macOS-arm64-FrameCull.AI.Flash_0.1.6_aarch64.dmg) · [Flash Intel x64](https://github.com/Ray25010/Frame-Cull-AI/releases/download/flash-ui-0.1.6-run-32216774744/FrameCull-Flash-macOS-x64-FrameCull.AI.Flash_0.1.6_x64.dmg)
- [Pro Apple Silicon arm64](https://github.com/Ray25010/Frame-Cull-AI/releases/download/pro-ui-0.1.6-run-32216774744/FrameCull-Pro-macOS-arm64-FrameCull.AI.Pro_0.1.6_aarch64.dmg) · [Pro Intel x64](https://github.com/Ray25010/Frame-Cull-AI/releases/download/pro-ui-0.1.6-run-32216774744/FrameCull-Pro-macOS-x64-FrameCull.AI.Pro_0.1.6_x64.dmg)

> macOS 测试包尚未经过 Apple Developer ID 签名和公证。Apple Silicon Mac 请选择 arm64，Intel Mac 请选择 x64。macOS Pro 已内置 RawTherapee 5.12，无需另外安装或授权。

### 📚 文档与教程

- [FrameCull AI Flash v0.1.6 简介及教程](https://www.kdocs.cn/l/ckvgLtjq13lO)
- [FrameCull AI Pro v0.1.6 简介及使用教程](https://www.kdocs.cn/l/ck6O3N1pAKlA)
- [macOS 安装教程](https://www.kdocs.cn/l/csMm8cw85pTP)


### 💻 系统要求

| 项目 | Flash Windows | Flash macOS | Pro Windows | Pro macOS |
| --- | --- | --- | --- | --- |
| 系统 | Windows 10 / 11 64 位 | macOS 12 Monterey 或更高，推荐 macOS 13 及以上 | Windows 10 / 11 64 位，推荐 Windows 11 | macOS 12 Monterey 或更高，推荐 macOS 13 及以上 |
| 架构 | x64 | Apple Silicon 使用 arm64 包；Intel Mac 使用 x64 包 | x64 | Apple Silicon 使用 arm64 包；Intel Mac 使用 x64 包 |
| CPU | 4 核起，推荐 8 核或更高 | Apple Silicon，或 4 核及以上 Intel 处理器 | 8 核起，推荐 12 核或更高 | Apple Silicon，或 6 核及以上 Intel 处理器 |
| 内存 | 8 GB 起，推荐 16 GB | 8 GB 起，推荐 16 GB | 16 GB 起，推荐 32 GB 或更高 | 16 GB 起，推荐 32 GB 或更高 |
| 显卡 | 无独显要求，集成显卡可运行 | 无独显要求，使用系统图形与 WebKit | NVIDIA GTX 1660 / RTX 2060 / RTX 3050 及以上可用，推荐 RTX 3060 / RTX 4060 及以上；无独显时可 CPU 兜底但会更慢 | 无独显要求，使用系统图形与 WebKit；Pro RAW 监看会占用更多资源 |
| 磁盘 | 2 GB 可用空间，建议 SSD | 2 GB 可用空间，建议 SSD | 10 GB 起，推荐 30 GB 以上 SSD 空间用于模型、RAW 监看缓存和导出 | 15 GB 起，推荐 30 GB 以上 SSD 空间用于内置 RawTherapee、模型、RAW 缓存和导出 |

### 🧩 核心能力

#### 🤖 AI 筛片

- 标记疑似闭眼、失焦、曝光异常、亮部/暗部细节丢失等需要复查的照片。
- 人像优先关注真实主体，减少背景人物、路人和前景遮挡造成的误报。
- 风景、空镜、背影、环境人像和活动照片会结合画面结构、曝光和美学线索判断。
- AI 精选不是简单按分数排序，而是先避开明显硬伤，再给出更值得优先查看的候选。

#### 🧬 Pro 蒸馏 AI 引擎

Pro 版不只是 Flash 加 RAW 监看。它加入了我们自训练和蒸馏的本地 AI 引擎：先用 CLIP / DINOv2 / MUSIQ 等教师模型和人工筛片数据离线训练，再导出更适合本地运行的学生模型，用于辅助低比例 AI 精选排序。

Pro 引擎会输出美学、场景、persona 等多头分数，帮助判断户外活动、环境人像、空镜、背影、合照和复杂场景。它不会绕过硬伤门禁：明显失焦、闭眼硬伤、弃用片和重复组非代表不会因为模型分数高而被强行选入。

#### 👥 人物分片

- 自动把当前批次中的同一人物聚为一组。
- 支持人物命名、合并、拆分和手动移动人脸。
- 同一张多人照片可以同时归入多个人物组。
- 支持按人物筛选照片并导出结果。

#### 🧹 重复照片清理

- 自动识别相似照片、连拍和重复组。
- 每组推荐一张更值得保留的代表图。
- 支持分组查看、best 标记、同步当前照片和大图复核。

#### 🎞 RAW + JPG 工作流

- 自动配对同名 RAW + JPG，也保留单独 RAW 或 JPG 文件。
- 支持保留、弃用、未标记、星级、AI 正常、AI 待复查、AI 精选、重复照片、合照等筛选。
- 支持 JPEG / TIFF / PNG 导出、原片复制或移动、RAW 同名 XMP sidecar。
- 支持一键打开 Lightroom Classic 到所选照片文件夹，继续后期流程。

#### 🌈 Pro RAW 监看 / 自动曝光 / LUT

- RAW 监看用于在筛片阶段提前判断 RAW 色彩、曝光和后期潜力。
- 自动曝光预览用于快速判断 RAW 的可恢复空间。
- LUT 监看支持导入 `.cube` 3D LUT，并以 0-100% 强度预览色彩方向。
- RAW 监看和自动曝光默认关闭，用户手动生成缓存后再启用，不阻断 JPG 筛片流程。

### 🚧 当前状态

FrameCull AI 仍处于内测阶段。Windows Flash/Pro x64 安装包和 macOS Flash/Pro 双架构测试包均已开放下载。macOS 测试包尚未签名和公证，首次打开请按上方教程操作。欢迎反馈真实筛片需求、测试样片和工作流建议。

### 📮 联系作者

- 邮箱：`2923834023@qq.com`

---

## English

**FrameCull AI** is a desktop photo-culling workspace for photographers. It brings fast review, AI review signals, AI Picks, duplicate cleanup, people grouping, ratings, Lightroom Classic handoff, and export management into one focused app.

FrameCull AI runs locally. It does not upload your photos, and it does not silently delete anything for you. The AI helps organize signals, rank candidates, and reduce repetitive work; the final keep, reject, rating, and export decisions remain yours.

### ✨ Editions

| Edition | Best for | Highlights |
| --- | --- | --- |
| ⚡ **FrameCull AI Flash** | Users who want a lightweight and fast local culling tool | Smaller installer, quick startup, fast navigation, local AI culling, people grouping, duplicate cleanup |
| 🧠 **FrameCull AI Pro** | Users who need stronger AI Picks, RAW exposure preview, and a more advanced workflow | Self-trained distilled AI engine, Pro persona ranking, RAW monitor preview, auto-exposure preview, LUT preview |

In short: **Flash is lighter. Pro is stronger.**  
Choose Flash if you mainly review JPGs or embedded RAW previews and care most about speed. Choose Pro if you want the Pro AI engine, RAW auto-exposure preview, and LUT monitoring.

### 📦 Download

Latest UI update test builds:
[Flash 0.1.6 prerelease](https://github.com/Ray25010/Frame-Cull-AI/releases/tag/flash-ui-0.1.6-run-32216774744) · [Pro 0.1.6 prerelease](https://github.com/Ray25010/Frame-Cull-AI/releases/tag/pro-ui-0.1.6-run-32216774744)

#### Windows

- [Flash x64 EXE](https://github.com/Ray25010/Frame-Cull-AI/releases/download/flash-ui-0.1.6-run-32216774744/FrameCull-Flash-Windows-x64-FrameCull.AI.Flash_0.1.6_x64-setup.exe) · [Flash x64 MSI](https://github.com/Ray25010/Frame-Cull-AI/releases/download/flash-ui-0.1.6-run-32216774744/FrameCull-Flash-Windows-x64-FrameCull.AI.Flash_0.1.6_x64_en-US.msi)
- [Pro x64 EXE](https://github.com/Ray25010/Frame-Cull-AI/releases/download/pro-ui-0.1.6-run-32216774744/FrameCull-Pro-Windows-x64-FrameCull.AI.Pro_0.1.6_x64-setup.exe) · [Pro x64 MSI](https://github.com/Ray25010/Frame-Cull-AI/releases/download/pro-ui-0.1.6-run-32216774744/FrameCull-Pro-Windows-x64-FrameCull.AI.Pro_0.1.6_x64_en-US.msi)

#### macOS

- [Flash Apple Silicon arm64](https://github.com/Ray25010/Frame-Cull-AI/releases/download/flash-ui-0.1.6-run-32216774744/FrameCull-Flash-macOS-arm64-FrameCull.AI.Flash_0.1.6_aarch64.dmg) · [Flash Intel x64](https://github.com/Ray25010/Frame-Cull-AI/releases/download/flash-ui-0.1.6-run-32216774744/FrameCull-Flash-macOS-x64-FrameCull.AI.Flash_0.1.6_x64.dmg)
- [Pro Apple Silicon arm64](https://github.com/Ray25010/Frame-Cull-AI/releases/download/pro-ui-0.1.6-run-32216774744/FrameCull-Pro-macOS-arm64-FrameCull.AI.Pro_0.1.6_aarch64.dmg) · [Pro Intel x64](https://github.com/Ray25010/Frame-Cull-AI/releases/download/pro-ui-0.1.6-run-32216774744/FrameCull-Pro-macOS-x64-FrameCull.AI.Pro_0.1.6_x64.dmg)

> macOS test packages are not signed or notarized with Apple Developer ID. Choose arm64 for Apple Silicon and x64 for Intel Macs. macOS Pro bundles RawTherapee 5.12, so no separate installation or authorization is required. This build does not include Beauty features or UI.

### 📚 Docs

- [FrameCull AI Flash v0.1.6 guide on WPS Docs](https://www.kdocs.cn/l/ckvgLtjq13lO)
- [FrameCull AI Pro v0.1.6 guide on WPS Docs](https://www.kdocs.cn/l/ck6O3N1pAKlA)
- [macOS Flash installation guide](https://www.kdocs.cn/l/csMm8cw85pTP)

#### macOS installation notes

1. Download the `arm64` DMG for Apple Silicon or the `x64` DMG for an Intel Mac.
2. Open the DMG and drag FrameCull AI Flash or FrameCull AI Pro into Applications.
3. If macOS cannot verify the developer, right-click the app in Finder, choose Open, and confirm once more.
4. Pro bundles RawTherapee 5.12. No separate RawTherapee installation or authorization is required.

### 💻 Requirements

| Item | Flash Windows | Flash macOS | Pro Windows | Pro macOS |
| --- | --- | --- | --- | --- |
| OS | Windows 10 / 11 64-bit | macOS 12 Monterey or later; macOS 13 or later preferred | Windows 10 / 11 64-bit, Windows 11 recommended | macOS 12 Monterey or later; macOS 13 or later preferred |
| Architecture | x64 | Use the arm64 package on Apple Silicon and the x64 package on Intel Macs | x64 | Use the arm64 package on Apple Silicon and the x64 package on Intel Macs |
| CPU | 4 cores minimum, 8+ cores recommended | Apple Silicon, or a 4-core or better Intel processor | 8 cores minimum, 12+ cores recommended | Apple Silicon, or a 6-core or better Intel processor |
| Memory | 8 GB minimum, 16 GB recommended | 8 GB minimum, 16 GB recommended | 16 GB minimum, 32 GB or more recommended | 16 GB minimum, 32 GB or more recommended |
| GPU | No discrete GPU required | No discrete GPU required; uses system graphics and WebKit | NVIDIA GTX 1660 / RTX 2060 / RTX 3050 or above; RTX 3060 / RTX 4060 or above recommended. CPU fallback is available but slower | No discrete GPU required; uses system graphics and WebKit. Pro RAW monitoring uses more resources |
| Disk | 2 GB free space, SSD recommended | 2 GB free space, SSD recommended | 10 GB minimum, 30 GB or more SSD space recommended for models, RAW preview cache, and exports | 15 GB minimum, 30 GB or more SSD space recommended for bundled RawTherapee, models, RAW cache, and exports |

### 🧩 Core Features

#### 🤖 AI Culling

- Flags photos that may need review, such as closed eyes, missed focus, exposure issues, and lost highlight or shadow detail.
- Prioritizes the real subject in portraits to reduce false alarms from background people or foreground occlusion.
- Handles landscapes, empty scenes, back views, environmental portraits, and event photos with scene, exposure, and aesthetic signals.
- AI Picks avoid obvious hard faults first, then surface stronger candidates for review.

#### 🧬 Pro Distilled AI Engine

Pro is not just Flash with RAW preview. It adds a self-trained distilled local AI engine. Teacher models such as CLIP / DINOv2 / MUSIQ and human culling data are used offline to train smaller student models that better match real photo-culling preferences.

The Pro engine produces aesthetic, scene, and persona scores for AI Pick ranking, especially at stricter pick ratios. It does not override hard gates: obviously out-of-focus images, closed-eye hard faults, rejected photos, and duplicate non-representatives are still blocked by the rule layer.

#### 👥 People Grouping

- Groups the same person across the current batch.
- Supports naming, merging, splitting, and manually moving faces.
- Allows one group photo to belong to multiple people groups.
- Supports filtering and exporting by person.

#### 🧹 Duplicate Cleanup

- Detects similar images, burst sequences, and duplicate groups.
- Recommends a better representative for each group.
- Provides a duplicate review workspace for grouped review, best marking, current-photo sync, and large preview checks.

#### 🎞 RAW + JPG Workflow

- Pairs matching RAW + JPG files while keeping standalone RAW or JPG files.
- Supports keep, reject, unmarked, star rating, AI normal, AI review, AI Pick, duplicate, and group-photo filters.
- Supports JPEG / TIFF / PNG export, original file copy or move, and RAW sidecar XMP.
- Opens Lightroom Classic to the selected photo folder for downstream editing.

#### 🌈 Pro RAW Monitor / Auto Exposure / LUT

- RAW monitor preview helps judge RAW color, exposure, and post-processing potential during culling.
- Auto-exposure preview helps estimate recoverable RAW range quickly.
- LUT monitor supports `.cube` 3D LUT files with 0-100% preview strength.
- RAW monitor and auto exposure are off by default; users generate caches manually, so JPG culling stays available.

### 🚧 Status

FrameCull AI is currently in beta. Windows Flash/Pro x64 installers and dual-architecture macOS Flash/Pro test packages are available. The macOS packages are not signed or notarized, so follow the installation steps above for first launch.

Feedback on real culling needs, test samples, and workflow improvements is welcome.

### 📮 Contact

- Email: `2923834023@qq.com`
