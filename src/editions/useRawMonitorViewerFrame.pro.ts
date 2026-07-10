import { useEffect, useState } from 'react';
import type { MutableRefObject } from 'react';
import type { Language } from '../i18n';
import type {
  AiAnalysis,
  AutoExposurePreviewAdjustment,
  PhotoGroup,
  RawMonitorFallbackReason,
  RawMonitorProfileId,
} from '../types';
import {
  getRawMonitorCacheEntry,
  peekRawMonitorCacheEntry,
  RAW_MONITOR_BALANCED_PROFILE_ID,
} from '../utils/rawMonitorEngine';

export type RawMonitorViewerFrame = {
  groupId: string;
  url: string;
  alt: string;
  ai?: AiAnalysis;
  autoExposure?: AutoExposurePreviewAdjustment | null;
  source?: 'rawtherapee-cache' | 'embedded-preview';
  fallbackReason?: RawMonitorFallbackReason;
};

export type RawMonitorPreviewState = {
  enabled: boolean;
  autoExposureEnabled?: boolean;
  profileId?: RawMonitorProfileId;
  engineVersion?: string;
  cacheVersion: number;
};

export type RawMonitorViewerStatus = 'inactive' | 'checking' | 'ready' | 'missing' | 'error';

export function useRawMonitorViewerFrame({
  group,
  language,
  preview,
  currentGroupId,
}: {
  group: PhotoGroup;
  language: Language;
  preview?: RawMonitorPreviewState;
  currentGroupId: MutableRefObject<string | null>;
}) {
  const [frame, setFrame] = useState<RawMonitorViewerFrame | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [status, setStatus] = useState<RawMonitorViewerStatus>('inactive');

  useEffect(() => {
    setFrame(null);
    setNotice(null);
    setStatus('inactive');

    const rawPath = group.raw?.path;
    const engineVersion = preview?.engineVersion;
    const profileId = preview?.profileId ?? RAW_MONITOR_BALANCED_PROFILE_ID;
    const cacheVersion = preview?.cacheVersion ?? 0;
    const monitorCacheEnabled = Boolean(preview?.enabled && rawPath && engineVersion);
    if (!rawPath || !monitorCacheEnabled) return;

    let cancelled = false;
    if (!engineVersion) return;

    const cached = peekRawMonitorCacheEntry(rawPath, engineVersion, profileId, cacheVersion);
    if (cached?.cacheUrl && cached.fromCache) {
      setFrame({
        groupId: group.id,
        url: cached.cacheUrl,
        alt: group.id,
        ai: group.ai,
        source: cached.fallback ? 'embedded-preview' : 'rawtherapee-cache',
        fallbackReason: cached.fallbackReason,
      });
      setStatus('ready');
      setNotice(cacheReadyLabel(language, cached.fallback === true, cached.fallbackReason));
      return;
    }

    setStatus('checking');
    setNotice(language === 'zh' ? '检查 RAW 监看缓存' : 'Checking RAW monitor cache');

    void getRawMonitorCacheEntry(rawPath, engineVersion, profileId, cacheVersion)
      .then(entry => {
        if (cancelled || currentGroupId.current !== group.id) return;
        if (entry?.cacheUrl && entry.fromCache) {
          setFrame({
            groupId: group.id,
            url: entry.cacheUrl,
            alt: group.id,
            ai: group.ai,
            source: entry.fallback ? 'embedded-preview' : 'rawtherapee-cache',
            fallbackReason: entry.fallbackReason,
          });
          setStatus('ready');
          setNotice(cacheReadyLabel(language, entry.fallback === true, entry.fallbackReason));
        } else {
          setStatus('missing');
          setNotice(language === 'zh' ? '需要先生成 RAW 监看缓存' : 'Generate RAW monitor cache first');
        }
      })
      .catch(error => {
        if (cancelled || currentGroupId.current !== group.id) return;
        console.warn('Failed to read RAW monitor cache:', error);
        setStatus('error');
        setNotice(language === 'zh' ? 'RAW 监看缓存不可用' : 'RAW monitor cache unavailable');
      });

    return () => {
      cancelled = true;
    };
  }, [
    group.id,
    group.raw?.path,
    group.ai,
    language,
    preview?.enabled,
    preview?.engineVersion,
    preview?.profileId,
    preview?.cacheVersion,
    currentGroupId,
  ]);

  const active = Boolean(preview?.enabled && group.raw?.path && preview?.engineVersion);
  return { frame, notice, status, active };
}

export function cacheReadyLabel(
  language: Language,
  fallback: boolean,
  fallbackReason?: RawMonitorFallbackReason,
) {
  if (fallbackReason === 'decodeFailure') {
    return language === 'zh'
      ? 'RAW 解码器无法读取，已使用相机内嵌预览'
      : 'RAW decoder unavailable; using embedded camera preview';
  }
  if (fallbackReason === 'engineError') {
    return language === 'zh'
      ? 'RAW 引擎不可用，已使用相机内嵌预览'
      : 'RAW engine unavailable; using embedded camera preview';
  }
  if (fallbackReason === 'missingOutput' || fallbackReason === 'invalidOutput') {
    return language === 'zh'
      ? 'RAW 引擎输出异常，已使用相机内嵌预览'
      : 'Invalid RAW engine output; using embedded camera preview';
  }
  if (fallback) return language === 'zh' ? 'RAW 内嵌预览兜底' : 'Embedded RAW preview fallback';
  return language === 'zh' ? 'RAW 监看缓存' : 'RAW monitor cache';
}
