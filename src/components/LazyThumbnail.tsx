import React, { memo, useEffect, useRef, useState } from 'react';
import { PhotoGroup } from '../types';
import { getCachedJpegThumbnail, loadJpegThumbnail } from '../utils/jpegThumbnailLoader';
import { decodeRawFile, getThumbnailFromCache } from '../utils/rawLoader';

interface LazyThumbnailProps {
  group: PhotoGroup;
  isVisible?: boolean;
}

const LazyThumbnail: React.FC<LazyThumbnailProps> = memo(({ group, isVisible = false }) => {
  const [thumbnailUrl, setThumbnailUrl] = useState<string | null>(() => getInitialThumbnailUrl(group));
  const [isLoading, setIsLoading] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [inView, setInView] = useState(isVisible);
  const containerRef = useRef<HTMLDivElement>(null);
  const loadedRef = useRef(false);
  const requestTokenRef = useRef(0);
  const fallbackAttemptRef = useRef(false);

  useEffect(() => {
    if (isVisible) setInView(true);
  }, [isVisible]);

  useEffect(() => {
    const element = containerRef.current;
    if (!element) return;

    const observer = new IntersectionObserver(
      entries => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          setInView(true);
          observer.unobserve(element);
          break;
        }
      },
      {
        rootMargin: '420px 0px',
        threshold: 0.01,
      },
    );

    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    requestTokenRef.current += 1;
    loadedRef.current = false;
    fallbackAttemptRef.current = false;
    const initialThumbnail = getInitialThumbnailUrl(group);
    setThumbnailUrl(initialThumbnail);
    loadedRef.current = Boolean(initialThumbnail);
    setHasError(false);
    setIsLoading(false);
    setInView(isVisible);
  }, [group.id, group.jpg?.path, group.jpg?.previewUrl, group.raw?.path]);

  useEffect(() => {
    if (!inView || loadedRef.current) return;

    if (group.jpg?.previewUrl) {
      const requestToken = ++requestTokenRef.current;
      const cachedThumbnail = group.jpg.path ? getCachedJpegThumbnail(group.jpg.path) : null;
      if (cachedThumbnail) {
        setThumbnailUrl(cachedThumbnail);
        loadedRef.current = true;
        return;
      }

      if (!group.jpg.path) {
        setThumbnailUrl(group.jpg.previewUrl);
        loadedRef.current = true;
        return;
      }

      setIsLoading(true);
      loadJpegThumbnail(group.jpg.path, group.jpg.previewUrl, 360, isVisible ? 'high' : 'low')
        .then(url => {
          if (requestTokenRef.current !== requestToken) return;
          setThumbnailUrl(url);
          loadedRef.current = true;
          setIsLoading(false);
        })
        .catch(error => {
          if (requestTokenRef.current !== requestToken) return;
          console.error('Failed to load JPEG thumbnail:', error);
          setThumbnailUrl(group.jpg?.previewUrl ?? null);
          loadedRef.current = Boolean(group.jpg?.previewUrl);
          setIsLoading(false);
        });
      return;
    }

    if (!group.raw?.path) return;

    const requestToken = ++requestTokenRef.current;
    const cachedThumbnail = getThumbnailFromCache(group.raw.path);
    if (cachedThumbnail) {
      setThumbnailUrl(cachedThumbnail);
      loadedRef.current = true;
      return;
    }

    setIsLoading(true);
    decodeRawFile(group.raw.path, true, { priority: 'low', silent: true })
      .then(dataUrl => {
        if (requestTokenRef.current !== requestToken) return;
        setThumbnailUrl(dataUrl);
        loadedRef.current = true;
        setIsLoading(false);
      })
      .catch(error => {
        if (requestTokenRef.current !== requestToken) return;
        console.error('Failed to load RAW thumbnail:', error);
        loadedRef.current = false;
        setHasError(true);
        setIsLoading(false);
      });
  }, [group.id, group.jpg, group.raw, inView]);

  const handleImageError = () => {
    if (!group.raw?.path || fallbackAttemptRef.current) {
      loadedRef.current = false;
      setThumbnailUrl(null);
      setHasError(true);
      setIsLoading(false);
      return;
    }

    fallbackAttemptRef.current = true;
    loadedRef.current = false;
    setThumbnailUrl(null);
    setHasError(false);
    setIsLoading(true);

    const requestToken = ++requestTokenRef.current;
    decodeRawFile(group.raw.path, true, {
      priority: 'low',
      silent: true,
      allowEmbeddedPreview: false,
      bypassCache: true,
    })
      .then(dataUrl => {
        if (requestTokenRef.current !== requestToken) return;
        setThumbnailUrl(dataUrl);
        loadedRef.current = true;
        setIsLoading(false);
      })
      .catch(error => {
        if (requestTokenRef.current !== requestToken) return;
        console.error('Failed to load RAW thumbnail fallback:', error);
        loadedRef.current = false;
        setHasError(true);
        setIsLoading(false);
      });
  };

  return (
    <div ref={containerRef} className="h-full w-full">
      {isLoading ? (
        <ThumbnailPlaceholder icon="fa-image" />
      ) : hasError ? (
        <ThumbnailPlaceholder icon="fa-triangle-exclamation" tone="warning" />
      ) : thumbnailUrl ? (
        <img
          src={thumbnailUrl}
          className="h-full w-full object-cover"
          alt={group.id}
          loading={inView || isVisible ? 'eager' : 'lazy'}
          decoding="async"
          onError={handleImageError}
        />
      ) : (
        <ThumbnailPlaceholder icon="fa-file-image" />
      )}
    </div>
  );
});

const ThumbnailPlaceholder = ({
  icon,
  tone = 'neutral',
}: {
  icon: string;
  tone?: 'neutral' | 'warning';
}) => (
  <div className="flex h-full w-full items-center justify-center bg-zinc-800">
    <i className={`fa-solid ${icon} text-xs ${tone === 'warning' ? 'text-amber-600' : 'text-zinc-700'}`} />
  </div>
);

LazyThumbnail.displayName = 'LazyThumbnail';

export default LazyThumbnail;

function getInitialThumbnailUrl(group: PhotoGroup) {
  if (group.jpg?.path) return getCachedJpegThumbnail(group.jpg.path);
  if (group.jpg?.previewUrl) return group.jpg.previewUrl;
  if (group.raw?.path) return getThumbnailFromCache(group.raw.path);
  return null;
}
