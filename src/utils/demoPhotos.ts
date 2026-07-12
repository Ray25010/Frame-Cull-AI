import { GroupStatus, type AiPhotoScore, type AiPhotoScoreComponentKey, type AiPhotoScoreGrade, PhotoGroup, SelectionState } from '../types';
import { AI_MODEL_VERSION } from './aiLabels';

export function createAiDemoPhotos(): PhotoGroup[] {
  return [
    {
      id: 'AI_DEMO_FLAGGED',
      jpg: {
        name: 'AI_DEMO_FLAGGED.jpg',
        extension: 'JPG',
        file: null as unknown as File,
        previewUrl: demoImage('flagged'),
        size: 128000,
        modifiedMs: 1710000000000,
        path: 'demo/AI_DEMO_FLAGGED.jpg',
      },
      status: GroupStatus.JPG_ONLY,
      selection: SelectionState.UNMARKED,
      rating: 0,
      ai: {
        status: 'DONE',
        issues: [
          {
            code: 'OUT_OF_FOCUS',
            level: 'ISSUE',
            confidence: 0.82,
            score: 22,
            threshold: 35,
            message: 'Face or image sharpness is below the local threshold.',
          },
          {
            code: 'EYES_CLOSED',
            level: 'ISSUE',
            confidence: 0.91,
            score: 0.91,
            threshold: 0.7,
            message: 'A detected primary face appears to have both eyes closed.',
          },
        ],
        confidence: 0.91,
        preset: 'standard',
        reviewed: false,
        modelVersion: AI_MODEL_VERSION,
        analyzedAt: Date.now(),
        faceModelStatus: 'READY',
        metrics: {
          sharpness: 22,
          tenengrad: 26,
          edgeDensity: 0.08,
          focusTextureScore: 22,
          meanLuma: 118,
          subjectMeanLuma: 112,
          darkClipRatio: 0.04,
          highlightClipRatio: 0.02,
          subjectDarkClipRatio: 0.06,
          subjectHighlightClipRatio: 0.01,
          faceCount: 1,
          eyeClosedScore: 0.91,
        },
        regions: [
          {
            x: 0.32,
            y: 0.2,
            width: 0.36,
            height: 0.48,
            source: 'face',
            label: 'Primary face ROI',
          },
        ],
        photoScore: demoPhotoScore(49, 'REVIEW', {
          TECHNICAL_QUALITY: 34,
          AESTHETIC_QUALITY: 58,
          SCENE_FIT: 52,
          EXPOSURE_LATITUDE: 68,
          AI_RISK: 18,
        }),
      },
    },
    {
      id: 'AI_DEMO_CLEAR',
      jpg: {
        name: 'AI_DEMO_CLEAR.jpg',
        extension: 'JPG',
        file: null as unknown as File,
        previewUrl: demoImage('clear'),
        size: 116000,
        modifiedMs: 1710000001000,
        path: 'demo/AI_DEMO_CLEAR.jpg',
      },
      status: GroupStatus.JPG_ONLY,
      selection: SelectionState.UNMARKED,
      rating: 0,
      ai: {
        status: 'DONE',
        issues: [],
        confidence: 0,
        preset: 'standard',
        reviewed: false,
        modelVersion: AI_MODEL_VERSION,
        analyzedAt: Date.now(),
        faceModelStatus: 'READY',
        metrics: {
          sharpness: 86,
          tenengrad: 90,
          edgeDensity: 0.22,
          focusTextureScore: 86,
          meanLuma: 132,
          darkClipRatio: 0.01,
          highlightClipRatio: 0.01,
          faceCount: 0,
        },
        regions: [
          {
            x: 0.14,
            y: 0.14,
            width: 0.72,
            height: 0.72,
            source: 'center',
            label: 'Center-weighted ROI',
          },
        ],
        photoScore: demoPhotoScore(86, 'GOOD', {
          TECHNICAL_QUALITY: 90,
          AESTHETIC_QUALITY: 84,
          SCENE_FIT: 82,
          EXPOSURE_LATITUDE: 88,
          AI_RISK: 92,
        }),
      },
    },
  ];
}

function demoPhotoScore(
  overall: number,
  grade: AiPhotoScoreGrade,
  scores: Record<AiPhotoScoreComponentKey, number>,
): AiPhotoScore {
  const weights: Record<AiPhotoScoreComponentKey, number> = {
    TECHNICAL_QUALITY: 30,
    AESTHETIC_QUALITY: 25,
    SCENE_FIT: 15,
    EXPOSURE_LATITUDE: 15,
    AI_RISK: 10,
  };

  return {
    version: 'demo-score-preview',
    overall,
    grade,
    summary: 'Demo score for UI preview.',
    components: (Object.keys(weights) as AiPhotoScoreComponentKey[]).map(key => ({
      key,
      label: key,
      score: scores[key],
      weight: weights[key],
    })),
    aesthetic: {
      status: 'READY',
      score: scores.AESTHETIC_QUALITY,
      modelVersion: 'demo',
    },
    gates: {
      aiPickedEligible: grade !== 'REVIEW',
      technicalPass: scores.TECHNICAL_QUALITY >= 68,
      duplicateBestPass: true,
      reasons: [],
    },
  };
}

function demoImage(kind: 'flagged' | 'clear') {
  const accent = kind === 'flagged' ? '#f59e0b' : '#10b981';
  const label = kind === 'flagged' ? 'AI flagged demo' : 'AI clear demo';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800" viewBox="0 0 1200 800">
      <defs>
        <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#111827"/>
          <stop offset="1" stop-color="#0f172a"/>
        </linearGradient>
      </defs>
      <rect width="1200" height="800" fill="url(#bg)"/>
      <rect x="80" y="80" width="1040" height="640" rx="18" fill="#18181b" stroke="${accent}" stroke-width="6"/>
      <circle cx="600" cy="330" r="150" fill="#27272a" stroke="${accent}" stroke-width="10"/>
      <line x1="520" y1="315" x2="565" y2="315" stroke="${accent}" stroke-width="14" stroke-linecap="round"/>
      <line x1="635" y1="315" x2="680" y2="315" stroke="${accent}" stroke-width="14" stroke-linecap="round"/>
      <path d="M525 415 C570 455 630 455 675 415" fill="none" stroke="#e5e7eb" stroke-width="12" stroke-linecap="round"/>
      <text x="600" y="620" fill="#e5e7eb" font-family="Arial, sans-serif" font-size="56" font-weight="700" text-anchor="middle">${label}</text>
    </svg>
  `;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}
