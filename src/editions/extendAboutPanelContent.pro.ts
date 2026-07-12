import type { Language } from '../i18n';
import type { AboutPanelContent } from '../types/aboutPanelContent';

export function extendAboutPanelContent(
  base: AboutPanelContent,
  language: Language,
  productDisplayName: string,
): AboutPanelContent {
  if (language === 'zh') {
    return {
      ...base,
      subtitle: '面向专业摄影师的本地 AI 筛片、Pro 蒸馏模型与 RAW 监看助手。',
      intro: `${productDisplayName} 包含 Flash 版的快速看图、AI 复查线索、AI 精选、重复照片清理、人物分片、星级写入和导出整理，同时加入我们自己训练和蒸馏的 Pro AI 引擎，以及 RAW 监看、自动曝光预览和 LUT 预览。AI 分析在本机运行，不上传照片，也不替你黑箱删除照片。`,
      tags: ['Pro 蒸馏 AI', '本地推理', 'AI 精选', 'RAW 监看', 'LUT 预览'],
      sections: base.sections.map(section => {
        if (section.title === '核心优势') {
          return {
            ...section,
            title: 'Pro 核心优势',
            bullets: [
              'Pro 不只是 Flash + RAW 监看，核心是自训练/蒸馏的本地 AI 筛片模型。',
              'Pro persona 排序会学习哪些照片更像摄影师会留下的片，尤其服务低精选比例下的 AI Picks。',
              '语义、场景、美学和 persona 多头分数会辅助判断空镜、户外活动、环境人像、背影、合照和复杂场景。',
              'Pro 模型走 Rust 端原生 ONNX Runtime，优先使用可用的 GPU 加速链路，并保留 CPU 兜底。',
              'RAW 监看、自动曝光预览和 LUT 色彩预览用于在筛片阶段提前判断曝光、色彩和后期潜力。',
            ],
          };
        }
        if (section.title === 'AI 能力') {
          return {
            ...section,
            title: 'Pro AI 引擎',
            bullets: [
              '使用 teacher-student 训练流程，把更大的视觉模型、语义判断和人工筛片偏好蒸馏到本地学生模型里。',
              'Pro 模型输出美学、场景和 persona 信号，用于增强 AI 精选排序。',
              '低精选比例下优先提升人工会留下照片的排序位置，减少好片漏看。',
              '硬伤门禁仍由可解释规则控制，失焦、明显糊片、闭眼、弃用和重复非代表不会被模型分数救进精选。',
              'Flash 的 wasm AI 链路保持独立轻量，Pro 原生推理只在 Pro 版启用。',
            ],
          };
        }
        if (section.title === 'AI 精选与重复照片') {
          return {
            ...section,
            description: 'Pro 会在可解释规则之上，使用蒸馏学生模型的 persona 分数增强候选排序。',
            bullets: [
              'AI 精选先避开明显硬伤，再挑出更值得优先查看的候选片。',
              'Pro persona 分数会参与 AI Pick 排序，但不改变手动星级、保留、弃用标记。',
              '重复/连拍组会优先推荐可用 best，明显糊片、闭眼硬伤或已弃用照片不会成为 best。',
              '普通单张再按保留比例补足，适合先拿到一批优先复看的照片。',
            ],
          };
        }
        if (section.title === 'RAW+JPG 工作流') {
          return {
            ...section,
            title: 'RAW+JPG 与 RAW 监看',
            bullets: [
              '自动配对同名 RAW+JPG，也保留单独 RAW 或 JPG 文件。',
              '默认仍优先使用 JPG / 内嵌预览，RAW 监看和自动曝光预览默认关闭，按需手动开启。',
              'Pro Windows 包内置 RawTherapee 5.12 CLI，可生成 RAW 监看和自动曝光预览缓存。',
              '支持导入 .cube 3D LUT 实时预览色彩风格，不需要重新生成 RAW 缓存。',
              '设置页可查看 RAW 监看缓存占用、刷新大小、瘦身清理或单独清空缓存。',
            ],
          };
        }
        if (section.title === '系统要求') {
          return {
            ...section,
            bullets: [
              '当前 Pro 内测包主要面向 Windows 10 / 11 64 位。',
              '最低建议 6 核 CPU、16GB 内存、10GB 可用磁盘空间，推荐 SSD。',
              '显卡最低建议 NVIDIA GTX 1660 / RTX 2060 / RTX 3050 及以上，或同级 AMD 独显。',
              '推荐 NVIDIA RTX 3060 / RTX 4060 及以上；RTX 4070 及以上更适合大批量 Pro 推理。',
              '没有独立显卡也可以 CPU 兜底运行，但 Pro AI 推理和批量 RAW 缓存生成会明显变慢。',
            ],
          };
        }
        if (section.title === '当前定位') {
          return {
            ...section,
            bullets: [
              'Pro 是筛片与图库整理工具，不是 RAW 调色软件，也不是 Lightroom catalog 替代品。',
              'Pro AI 引擎用于让 AI 精选更接近真实摄影师筛片偏好，最终取舍仍由摄影师决定。',
              'RAW 监看用于辅助判断曝光、色彩和后期潜力，不替代完整后期调色流程。',
            ],
          };
        }
        return section;
      }),
    };
  }

  return {
    ...base,
    subtitle: 'A local AI culling assistant with Pro distilled models and RAW monitor previews.',
    intro: `${productDisplayName} includes Flash culling, AI review hints, AI Picks, duplicate cleanup, People Split, ratings, and export, then adds our in-house distilled Pro AI engine plus RAW monitor, auto-exposure preview, and LUT preview. AI runs locally and does not upload or automatically delete photos.`,
    tags: ['Pro Distilled AI', 'Local Inference', 'AI Picks', 'RAW Monitor', 'LUT Preview'],
    sections: base.sections.map(section => {
      if (section.title === 'Why It Stands Out') {
        return {
          ...section,
          title: 'Why Pro Stands Out',
          bullets: [
            'Pro is not only Flash plus RAW monitor; its core is an in-house distilled local culling model.',
            'Pro persona ranking learns which photos are closer to photographer keep decisions, especially at lower AI Pick ratios.',
            'Semantic, scene, aesthetic, and persona heads help with empty frames, outdoor events, environmental portraits, backs, groups, and complex scenes.',
            'The Pro model runs through native Rust ONNX Runtime with GPU acceleration when available and CPU fallback.',
            'RAW monitor, auto-exposure preview, and LUT preview help judge exposure, color, and editing potential during culling.',
          ],
        };
      }
      if (section.title === 'AI Capabilities') {
        return {
          ...section,
          title: 'Pro AI Engine',
          bullets: [
            'A teacher-student pipeline distills larger visual models, semantic signals, and manual culling preference into a local student model.',
            'The Pro model outputs aesthetic, scene, and persona signals for stronger AI Pick ranking.',
            'At lower pick ratios, persona ranking helps move human-kept photos higher and reduce missed good frames.',
            'Hard gates remain explainable rules: blur, closed eyes, rejects, and duplicate non-representatives are not rescued by model scores.',
            'The Flash wasm AI path stays separate and lightweight; native Pro inference only runs in Pro.',
          ],
        };
      }
      if (section.title === 'AI Picks And Duplicates') {
        return {
          ...section,
          description: 'Pro can use the distilled student persona score on top of explainable rules.',
          bullets: [
            'AI Picks avoid obvious hard issues before ranking candidate photos.',
            'Pro persona score can participate in AI Pick ranking without changing manual ratings, picks, or rejects.',
            'Duplicate / burst groups recommend a usable best; obvious blur, closed-eye hard issues, or rejected photos cannot become best.',
            'Single photos fill the remaining target ratio for a focused review set.',
          ],
        };
      }
      if (section.title === 'RAW+JPG Workflow') {
        return {
          ...section,
          title: 'RAW+JPG And RAW Monitor',
          bullets: [
            'Automatically pairs matching RAW+JPG files while keeping standalone RAW or JPG visible.',
            'By default it still shows JPG / embedded previews first; RAW monitor and auto exposure are off until enabled.',
            'The Pro Windows package bundles RawTherapee 5.12 CLI for RAW monitor and auto-exposure preview cache generation.',
            'Imported .cube 3D LUTs apply in real time without regenerating RAW cache.',
            'Settings can show RAW monitor cache size, refresh it, trim old cache, or clear it separately.',
          ],
        };
      }
      if (section.title === 'System Requirements') {
        return {
          ...section,
          bullets: [
            'Primary Pro beta target: Windows 10 / 11 64-bit.',
            'Minimum recommendation: 6-core CPU, 16GB RAM, 10GB free disk space, preferably SSD.',
            'GPU minimum recommendation: NVIDIA GTX 1660 / RTX 2060 / RTX 3050 or newer, or comparable AMD discrete GPU.',
            'Recommended: NVIDIA RTX 3060 / RTX 4060 or newer; RTX 4070+ is better for large-batch Pro inference.',
            'CPU fallback works, but Pro AI inference and batch RAW cache generation will be much slower without a discrete GPU.',
          ],
        };
      }
      if (section.title === 'Current Positioning') {
        return {
          ...section,
          bullets: [
            'Pro is a culling and library organization tool, not a RAW editor or Lightroom catalog replacement.',
            'The Pro AI engine aims to make AI Picks closer to real photographer preference; final decisions stay with the photographer.',
            'RAW monitor helps judge exposure, color, and editing potential during culling, but does not replace full post-production.',
          ],
        };
      }
      return section;
    }),
  };
}
