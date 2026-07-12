import type { AiFaceDiagnostic, AiPhotoKind } from '../types';

export type GroupPortraitDetection = {
  photoKind: AiPhotoKind;
  groupFaceIndices: number[];
  groupFaceCount: number;
  groupPortraitScore: number;
  groupPortraitReason: string;
};

export function detectGroupPortrait(faces: AiFaceDiagnostic[]): GroupPortraitDetection {
  const standard = (score: number, reason: string): GroupPortraitDetection => ({
    photoKind: 'STANDARD',
    groupFaceIndices: [],
    groupFaceCount: 0,
    groupPortraitScore: score,
    groupPortraitReason: reason,
  });

  const candidates = faces.filter(isGroupPortraitCandidate);
  if (candidates.length < 5) {
    return standard(0, 'Fewer than five reliable faces; treated as a standard photo.');
  }

  const largestFace = Math.max(...candidates.map(faceHeightRatio));
  const medianFace = median(candidates.map(faceHeightRatio));
  if (medianFace <= 0 || largestFace / medianFace > 1.85) {
    return standard(0.28, 'One face is much larger than the others; treated as a standard multi-person photo.');
  }

  const centersX = candidates.map(faceCenterX).sort((a, b) => a - b);
  const centersY = candidates.map(faceCenterY).sort((a, b) => a - b);
  const horizontalSpan = percentile(centersX, 0.9) - percentile(centersX, 0.1);
  if (horizontalSpan < 0.22) {
    return standard(0.34, 'Reliable faces are not spread across the frame like a posed group.');
  }

  const rows = clusterFaceRows(candidates);
  const ySpread = percentile(centersY, 0.9) - percentile(centersY, 0.1);
  const hasSingleGroupRow = rows.some(row => row.length >= 5 && rowCenterYSpread(row) <= 0.16);
  const compactRows = rows.filter(row => row.length >= 2 && rowCenterYSpread(row) <= 0.12);
  const hasTwoGroupRows = candidates.length >= 5 && compactRows.length >= 2 && ySpread <= 0.38;
  if (!hasSingleGroupRow && !hasTwoGroupRows) {
    return standard(0.4, 'Faces are not aligned closely enough to classify this as a formal group portrait.');
  }

  const rowDensityScores = rows
    .filter(row => row.length >= 2)
    .map(rowDensityScore);
  const densityScore = rowDensityScores.length > 0 ? Math.max(...rowDensityScores) : 0;
  if (densityScore < 0.45) {
    return standard(0.46, 'Faces are too loosely spaced for the conservative group portrait rule.');
  }

  const sizeSpread = coefficientOfVariation(candidates.map(faceHeightRatio));
  if (sizeSpread > 0.42) {
    return standard(0.5, 'Face sizes vary too much for the conservative group portrait rule.');
  }

  const countScore = clamp((candidates.length - 4) / 4);
  const alignmentScore = clamp(1 - ySpread / 0.38);
  const sizeScore = clamp(1 - sizeSpread / 0.42);
  const spreadScore = clamp(horizontalSpan / 0.46);
  const score = clamp(
    countScore * 0.24 +
    alignmentScore * 0.26 +
    sizeScore * 0.22 +
    densityScore * 0.18 +
    spreadScore * 0.1
  );

  if (score < 0.68) {
    return standard(score, 'Group portrait evidence is below the conservative threshold.');
  }

  return {
    photoKind: 'GROUP_PORTRAIT',
    groupFaceIndices: candidates.map(face => face.index),
    groupFaceCount: candidates.length,
    groupPortraitScore: score,
    groupPortraitReason: hasTwoGroupRows
      ? 'Detected a compact two-row group portrait; closed eyes are checked across all reliable group faces.'
      : 'Detected a compact row of reliable faces; closed eyes are checked across all reliable group faces.',
  };
}

function isGroupPortraitCandidate(face: AiFaceDiagnostic) {
  const heightRatio = faceHeightRatio(face);
  return (
    face.landmarkerStatus === 'OK' &&
    heightRatio >= 0.025 &&
    (face.faceQualityScore ?? 0) >= 0.32 &&
    (face.eyeReliability ?? 0) >= 0.16 &&
    !isStrongEdgeFace(face)
  );
}

function isStrongEdgeFace(face: AiFaceDiagnostic) {
  const touchesX = face.x <= 0.012 || face.x + face.width >= 0.988;
  const touchesY = face.y <= 0.012 || face.y + face.height >= 0.988;
  return (touchesX || touchesY) && (face.poseReliability ?? 0) < 0.24;
}

function clusterFaceRows(faces: AiFaceDiagnostic[]) {
  const rows: AiFaceDiagnostic[][] = [];
  faces
    .slice()
    .sort((a, b) => faceCenterY(a) - faceCenterY(b))
    .forEach(face => {
      const center = faceCenterY(face);
      const row = rows.find(items => Math.abs(center - median(items.map(faceCenterY))) <= 0.105);
      if (row) {
        row.push(face);
      } else {
        rows.push([face]);
      }
    });
  return rows;
}

function rowDensityScore(row: AiFaceDiagnostic[]) {
  const sorted = row.slice().sort((a, b) => faceCenterX(a) - faceCenterX(b));
  const gaps = sorted.slice(1).map((face, index) => faceCenterX(face) - faceCenterX(sorted[index]));
  if (gaps.length === 0) return 0;
  const medianGap = median(gaps);
  const medianWidth = median(sorted.map(face => face.width));
  const allowedGap = Math.max(0.16, medianWidth * 3.6);
  return clamp(1 - medianGap / (allowedGap * 1.8));
}

function rowCenterYSpread(row: AiFaceDiagnostic[]) {
  const centers = row.map(faceCenterY).sort((a, b) => a - b);
  return centers[centers.length - 1] - centers[0];
}

function faceCenterX(face: AiFaceDiagnostic) {
  return face.x + face.width / 2;
}

function faceCenterY(face: AiFaceDiagnostic) {
  return face.y + face.height / 2;
}

function faceHeightRatio(face: AiFaceDiagnostic) {
  return face.faceSizeRatio ?? face.height;
}

function median(values: number[]) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function percentile(values: number[], ratio: number) {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * ratio)));
  return sorted[index];
}

function coefficientOfVariation(values: number[]) {
  if (values.length === 0) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  if (mean <= 0) return 0;
  const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance) / mean;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}
