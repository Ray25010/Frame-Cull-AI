import type { MutableRefObject } from 'react';
import type { Language } from '../i18n';
import type { AiAnalysis, AutoExposurePreviewAdjustment, PhotoGroup, RawMonitorProfileId } from '../types';

export type RawMonitorViewerFrame = {
  groupId: string;
  url: string;
  alt: string;
  ai?: AiAnalysis;
  autoExposure?: AutoExposurePreviewAdjustment | null;
  source?: 'rawtherapee-cache' | 'embedded-preview-ae';
};

export type RawMonitorPreviewState = {
  enabled: boolean;
  autoExposureEnabled?: boolean;
  profileId?: RawMonitorProfileId;
  engineVersion?: string;
  cacheVersion: number;
};

export function useRawMonitorViewerFrame(_options: {
  group: PhotoGroup;
  language: Language;
  preview?: RawMonitorPreviewState;
  currentGroupId: MutableRefObject<string | null>;
}) {
  return {
    frame: null as RawMonitorViewerFrame | null,
    notice: null as string | null,
    status: 'inactive' as const,
    active: false,
  };
}
