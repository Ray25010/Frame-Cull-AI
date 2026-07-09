import type { PhotoGroup } from '../types';

export type PhotoTimeGap = {
  gapMs: number;
  source: 'capture' | 'modified';
};

export function captureTimeMs(photo: PhotoGroup) {
  return parseExifDateTimeMs(photo.exif?.dateTime);
}

export function primaryModifiedMs(photo: PhotoGroup) {
  const modified = photo.jpg?.modifiedMs ?? photo.raw?.modifiedMs;
  return typeof modified === 'number' && Number.isFinite(modified) && modified > 0 ? modified : undefined;
}

export function comparablePhotoTimeGap(left: PhotoGroup, right: PhotoGroup): PhotoTimeGap | undefined {
  const leftCapture = captureTimeMs(left);
  const rightCapture = captureTimeMs(right);
  if (leftCapture !== undefined && rightCapture !== undefined) {
    return { gapMs: Math.abs(leftCapture - rightCapture), source: 'capture' };
  }

  const leftModified = primaryModifiedMs(left);
  const rightModified = primaryModifiedMs(right);
  if (leftModified !== undefined && rightModified !== undefined) {
    return { gapMs: Math.abs(leftModified - rightModified), source: 'modified' };
  }

  return undefined;
}

export function photoSortValue(photo: PhotoGroup) {
  return captureTimeMs(photo) ?? primaryModifiedMs(photo) ?? trailingNumber(photo.id) ?? 0;
}

export function filenameNumericGap(left: string, right: string) {
  const leftNumber = trailingNumber(left);
  const rightNumber = trailingNumber(right);
  if (leftNumber === null || rightNumber === null) return undefined;
  return Math.abs(leftNumber - rightNumber);
}

export function trailingNumber(value: string) {
  const match = value.match(/(\d+)(?!.*\d)/);
  return match ? Number(match[1]) : null;
}

function parseExifDateTimeMs(value: string | undefined) {
  if (!value) return undefined;
  const text = value.trim();
  if (!text) return undefined;

  const exifMatch = text.match(
    /^(\d{4})[:/-](\d{2})[:/-](\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(?:\s*(Z|[+-]\d{2}:?\d{2}))?$/i,
  );
  if (exifMatch) {
    const [, year, month, day, hour, minute, second, fraction, zone] = exifMatch;
    const millisecond = Number((fraction ?? '0').slice(0, 3).padEnd(3, '0'));
    if (zone) {
      const normalizedZone = zone.toUpperCase() === 'Z'
        ? 'Z'
        : zone.includes(':')
          ? zone
          : `${zone.slice(0, 3)}:${zone.slice(3)}`;
      const parsed = Date.parse(`${year}-${month}-${day}T${hour}:${minute}:${second}.${String(millisecond).padStart(3, '0')}${normalizedZone}`);
      return Number.isFinite(parsed) ? parsed : undefined;
    }

    const localDate = new Date(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      millisecond,
    );
    const time = localDate.getTime();
    return Number.isFinite(time) ? time : undefined;
  }

  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : undefined;
}
