# FrameCull AI

> 本地 AI 筛片与图库整理助手 / Local AI photo culling and library cleanup assistant

FrameCull AI 是一款面向摄影师的桌面筛片工具。它把快速看图、AI 复查线索、AI 精选、重复照片清理、人物分片、星级写入、Lightroom Classic 交接和导出整理放在一个工作台里，帮助摄影师更快完成大批量照片初筛。

FrameCull AI 不上传照片，也不会替你黑箱删除照片。AI 负责整理线索、排序候选和减少重复劳动，最终保留、弃用、星级和导出判断仍由摄影师完成。

当前提供两个版本：

- **FrameCull AI Flash**：轻量快速版，专注本地 AI 筛片、图库整理、人物分片和重复照片清理。
- **FrameCull AI Pro**：高精度内测版，在 Flash 基础上加入自训练蒸馏 AI 引擎、Pro persona 排序、RAW 监看、自动曝光预览和 LUT 预览。

## 下载

最新版内测安装包在 GitHub Release：

[FrameCull AI 0.1.6 Beta](https://github.com/Ray25010/Frame-Cull-AI/releases/tag/v0.1.6-beta.1)

- [下载 Flash 版 Windows 安装包](https://github.com/Ray25010/Frame-Cull-AI/releases/download/v0.1.6-beta.1/FrameCull.AI.Flash_0.1.6_x64-setup.exe)
- [下载 Pro 版 Windows 安装包](https://github.com/Ray25010/Frame-Cull-AI/releases/download/v0.1.6-beta.1/FrameCull.AI.Pro_0.1.6_x64-setup.exe)

## 两个版本怎么选

| 版本 | 适合谁 | 主要特点 |
| --- | --- | --- |
| Flash | 想要轻量、快速、本地筛片和图库整理的用户 | 安装包更小，启动快，切图快，不包含 RAW 监看引擎 |
| Pro | 需要更强 AI 精选、低比例筛片召回、RAW 曝光预览和专业工作流的用户 | 自训练蒸馏 AI 引擎，Pro persona 排序，RAW 监看，自动曝光预览，LUT 预览 |

两个版本是独立应用。Flash 更轻，Pro 更强；如果你主要看 JPG / RAW 内嵌预览并追求速度，选择 Flash。如果你需要 Pro AI 引擎和 RAW 自动曝光预览，选择 Pro。

## 核心能力

### AI 筛片

- 标记疑似闭眼、失焦、曝光异常、细节丢失等需要复查的照片。
- 对人像优先看主体，减少背景人物、路人或前景遮挡造成的误报。
- 对风景、空镜、背影、环境人像和活动照片，会结合画面结构、曝光和美学线索判断。
- AI 精选不是简单按分数排序，而是先避开明显硬伤，再给出更值得优先查看的候选。

### 重复照片清理

- 自动识别相似照片、连拍和重复组。
- 每组推荐一张更值得保留的代表，减少图库里大量近似照片堆积。
- 重复照片工作台支持分组查看、best 标记、同步当前照片和大图复核。

### 人物分片

- 自动把当前批次中的同一人物聚为一组。
- 支持人物命名、合并、拆分和手动移动人脸。
- 同一张多人照片可以同时归入多个人物组。
- 支持按人物筛选照片并导出结果。

### RAW + JPG 工作流

- 自动配对同名 RAW + JPG，也保留单独 RAW 或 JPG 文件。
- 支持保留、弃用、未标记、星级、AI 正常、AI 待复查、AI 精选、重复照片、合照等筛选。
- 支持 JPEG / TIFF / PNG 导出、原片复制或移动、RAW 同名 XMP sidecar。
- 支持一键打开 Lightroom Classic 到所选照片文件夹，继续后期流程。

## Pro AI 引擎

Pro 版的重点不只是 RAW 监看。它加入了我们自己训练和蒸馏的本地 AI 引擎，用更大的教师模型和人工筛片数据训练出更适合摄影筛片偏好的学生模型，再在本机通过原生 ONNX Runtime 推理。

Pro 引擎会输出美学、场景、persona 等多头分数，用来辅助低比例 AI 精选排序。它不会覆盖硬伤门禁：明显失焦、闭眼、弃用片和重复组非代表不会因为模型分数高而被强行选入。

## 版本文档

详细功能和硬件要求请看：

- [Flash 版中文说明](docs/editions/README_FLASH_CN.md)
- [Pro 版中文说明](docs/editions/README_PRO_CN.md)

在线教程：

- [FrameCull AI Flash v0.1.6 简介及教程（金山文档）](https://www.kdocs.cn/l/ckvgLtjq13lO)
- [FrameCull AI Pro v0.1.6 简介及使用教程（金山文档）](https://www.kdocs.cn/l/ck6O3N1pAKlA)

## 系统要求

| 项目 | Flash 建议 | Pro 建议 |
| --- | --- | --- |
| 系统 | Windows 10 / 11 64 位 | Windows 10 / 11 64 位，推荐 Windows 11 |
| CPU | 4 核起，推荐 8 核或更高 | 8 核起，推荐 12 核或更高 |
| 内存 | 8 GB 起，推荐 16 GB | 16 GB 起，推荐 32 GB 或更高 |
| 显卡 | 无独显要求，集成显卡可运行 | NVIDIA GTX 1660 / RTX 2060 / RTX 3050 及以上可用，推荐 RTX 3060 / RTX 4060 及以上；无独显时可 CPU 兜底但会更慢 |
| 磁盘 | 2 GB 可用空间，建议 SSD | 10 GB 起，推荐 30 GB 以上 SSD 空间用于模型、RAW 监看缓存和导出 |

## 当前状态

FrameCull AI 仍处于内测阶段。当前 Windows 安装包已经可用于测试；macOS 版本需要单独构建和签名验证。

欢迎反馈真实筛片需求、测试样片和工作流建议。

## 联系作者

- 微信 / 手机同号：`18102631833`
- 邮箱：`2923834023@qq.com`

---

# FrameCull AI

> Local AI photo culling and library cleanup assistant

FrameCull AI is a desktop culling tool for photographers. It brings fast image review, AI review signals, AI Picks, duplicate cleanup, people grouping, ratings, Lightroom Classic handoff, and export management into one focused workspace.

FrameCull AI runs locally. It does not upload your photos, and it does not silently delete anything for you. The AI helps organize signals, rank candidates, and reduce repetitive work; the final keep, reject, rating, and export decisions remain yours.

Two editions are currently available:

- **FrameCull AI Flash**: the lightweight edition for fast local AI culling, library cleanup, people grouping, and duplicate review.
- **FrameCull AI Pro**: the high-accuracy beta edition with a self-trained distilled AI engine, Pro persona ranking, RAW monitor preview, auto-exposure preview, and LUT preview.

## Download

Latest beta release:

[FrameCull AI 0.1.6 Beta](https://github.com/Ray25010/Frame-Cull-AI/releases/tag/v0.1.6-beta.1)

- [Download Flash for Windows](https://github.com/Ray25010/Frame-Cull-AI/releases/download/v0.1.6-beta.1/FrameCull.AI.Flash_0.1.6_x64-setup.exe)
- [Download Pro for Windows](https://github.com/Ray25010/Frame-Cull-AI/releases/download/v0.1.6-beta.1/FrameCull.AI.Pro_0.1.6_x64-setup.exe)

## Which Edition Should I Use?

| Edition | Best for | Highlights |
| --- | --- | --- |
| Flash | Users who want a lightweight and fast local culling tool | Smaller installer, quick startup, fast navigation, no RAW monitoring engine |
| Pro | Users who need stronger AI Picks, low-ratio recall, RAW exposure preview, and a more advanced workflow | Self-trained distilled AI engine, Pro persona ranking, RAW monitor preview, auto-exposure preview, LUT preview |

Flash is lighter. Pro is stronger. Choose Flash if you mainly review JPGs or embedded RAW previews and care most about speed. Choose Pro if you want the Pro AI engine and RAW auto-exposure preview.

## Core Features

### AI Culling

- Flags photos that may need review, such as closed eyes, missed focus, exposure issues, and lost detail.
- Prioritizes the real subject in portraits to reduce false alarms from background people or foreground occlusion.
- Handles landscapes, empty scenes, back views, environmental portraits, and event photos with scene, exposure, and aesthetic signals.
- AI Picks avoid obvious hard faults first, then surface stronger candidates for review.

### Duplicate Cleanup

- Detects similar images, burst sequences, and duplicate groups.
- Recommends a better representative for each group.
- Provides a duplicate review workspace for grouped review, best marking, current-photo sync, and large preview checks.

### People Grouping

- Groups the same person across the current batch.
- Supports naming, merging, splitting, and manually moving faces.
- Allows one group photo to belong to multiple people groups.
- Supports filtering and exporting by person.

### RAW + JPG Workflow

- Pairs matching RAW + JPG files while keeping standalone RAW or JPG files.
- Supports keep, reject, unmarked, star rating, AI normal, AI review, AI Pick, duplicate, and group-photo filters.
- Supports JPEG / TIFF / PNG export, original file copy or move, and RAW sidecar XMP.
- Opens Lightroom Classic to the selected photo folder for downstream editing.

## Pro AI Engine

Pro is not just Flash with RAW preview. It adds a self-trained distilled local AI engine. Larger teacher models and human culling data are used offline to train a smaller student model that better matches real photo-culling preferences, then the app runs that model locally through native ONNX Runtime.

The Pro engine produces aesthetic, scene, and persona scores for AI Pick ranking, especially at stricter pick ratios. It does not override hard gates: obviously out-of-focus images, closed-eye hard faults, rejected photos, and duplicate non-representatives are still blocked by the rule layer.

## Edition Docs

Detailed feature notes and hardware requirements:

- [Flash edition Chinese guide](docs/editions/README_FLASH_CN.md)
- [Pro edition Chinese guide](docs/editions/README_PRO_CN.md)

Online Chinese tutorials:

- [FrameCull AI Flash v0.1.6 guide on WPS Docs](https://www.kdocs.cn/l/ckvgLtjq13lO)
- [FrameCull AI Pro v0.1.6 guide on WPS Docs](https://www.kdocs.cn/l/ck6O3N1pAKlA)

## Requirements

| Item | Flash Recommendation | Pro Recommendation |
| --- | --- | --- |
| OS | Windows 10 / 11 64-bit | Windows 10 / 11 64-bit, Windows 11 recommended |
| CPU | 4 cores minimum, 8+ cores recommended | 8 cores minimum, 12+ cores recommended |
| Memory | 8 GB minimum, 16 GB recommended | 16 GB minimum, 32 GB or more recommended |
| GPU | No discrete GPU required | NVIDIA GTX 1660 / RTX 2060 / RTX 3050 or above; RTX 3060 / RTX 4060 or above recommended. CPU fallback is available but slower |
| Disk | 2 GB free space, SSD recommended | 10 GB minimum, 30 GB or more SSD space recommended for models, RAW preview cache, and exports |

## Status

FrameCull AI is currently in beta. Windows installers are available for testing. macOS builds require separate build and signing validation.

Feedback on real culling needs, test samples, and workflow improvements is welcome.

## Contact

- WeChat / phone: `18102631833`
- Email: `2923834023@qq.com`
