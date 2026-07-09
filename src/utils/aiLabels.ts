import { AiIssue, AiIssueCode, AiIssueLevel, AiSensitivity, AiSettings, DuplicateSensitivity } from '../types';

export const AI_MODEL_VERSION = 'local-native-rules-v30-focus-eye-time';

export const DEFAULT_AI_SETTINGS: AiSettings = {
  enabledChecks: {
    OUT_OF_FOCUS: true,
    UNDER_EXPOSED: true,
    OVER_EXPOSED: true,
    EYES_CLOSED: true,
  },
  sensitivity: 'standard',
  sensitivityByCheck: {
    OUT_OF_FOCUS: 'standard',
    UNDER_EXPOSED: 'standard',
    OVER_EXPOSED: 'standard',
    EYES_CLOSED: 'standard',
  },
  duplicateSensitivity: 'standard',
  duplicateAlwaysRecommendOne: true,
  aiPickTargetRatio: 0.6,
  proPersonaRanking: {
    enabled: false,
  },
};

export function aiIssueLabel(code: AiIssueCode, language: 'zh' | 'en' = 'zh', level: AiIssueLevel = 'ISSUE') {
  const zh: Record<AiIssueCode, string> = {
    OUT_OF_FOCUS: '\u5931\u7126',
    UNDER_EXPOSED: '\u6b20\u66dd',
    OVER_EXPOSED: '\u8fc7\u66dd',
    EYES_CLOSED: '\u95ed\u773c',
  };
  const en: Record<AiIssueCode, string> = {
    OUT_OF_FOCUS: 'Out of focus',
    UNDER_EXPOSED: 'Underexposed',
    OVER_EXPOSED: 'Overexposed',
    EYES_CLOSED: 'Eyes closed',
  };
  const label = (language === 'zh' ? zh : en)[code];
  if (level === 'REVIEW_HINT') {
    return language === 'zh' ? `\u7591\u4f3c${label}` : `Possible ${label.toLowerCase()}`;
  }
  return label;
}

export function aiIssueIcon(code: AiIssueCode) {
  const icons: Record<AiIssueCode, string> = {
    OUT_OF_FOCUS: 'fa-bullseye',
    UNDER_EXPOSED: 'fa-moon',
    OVER_EXPOSED: 'fa-sun',
    EYES_CLOSED: 'fa-eye-slash',
  };
  return icons[code];
}

export function aiSensitivityLabel(value: AiSensitivity, language: 'zh' | 'en' = 'zh') {
  const zh: Record<AiSensitivity, string> = {
    weak: '\u5f31',
    standard: '\u6807\u51c6',
    strong: '\u5f3a',
  };
  const en: Record<AiSensitivity, string> = {
    weak: 'Weak',
    standard: 'Standard',
    strong: 'Strong',
  };
  return (language === 'zh' ? zh : en)[value];
}

export function duplicateSensitivityLabel(value: DuplicateSensitivity, language: 'zh' | 'en' = 'zh') {
  const zh: Record<DuplicateSensitivity, string> = {
    off: '不检测',
    loose: '轻度相似',
    standard: '一般相似',
    strict: '几乎一样',
  };
  const en: Record<DuplicateSensitivity, string> = {
    off: 'Off',
    loose: 'Loose',
    standard: 'Standard',
    strict: 'Strict',
  };
  return (language === 'zh' ? zh : en)[value];
}

export function formatConfidence(value: number) {
  return `${Math.round(Math.max(0, Math.min(1, value)) * 100)}%`;
}

export function highestIssueConfidence(issues: AiIssue[]) {
  return issues.reduce((max, issue) => Math.max(max, issue.confidence), 0);
}
