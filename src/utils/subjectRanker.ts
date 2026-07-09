import type { AiSubjectConfidence, AiSubjectRole } from '../types';

export type SubjectRankInput = {
  index: number;
  x: number;
  y: number;
  width: number;
  height: number;
  faceSizeRatio?: number;
  faceQualityScore?: number;
  eyeReliability?: number;
  poseReliability?: number;
  sharpnessScore?: number;
  landmarkerStatus?: 'OK' | 'FAILED' | 'SKIPPED';
};

export type RankedSubject = SubjectRankInput & {
  subjectRole: AiSubjectRole;
  subjectScore: number;
  subjectRank?: number;
  lookAtCameraScore: number;
  centerScore: number;
  sizeScore: number;
  sharpnessScore: number;
  cropSafetyScore: number;
  eligibleAsPrimary: boolean;
  subjectReason: string;
};

export type SubjectRanking = {
  faces: RankedSubject[];
  primaryFaceIndices: number[];
  primarySubjectCount: number;
  subjectConfidence: AiSubjectConfidence;
  subjectDecision: string;
};

const PRIMARY_SCORE_MIN = 0.52;
const HIGH_CONFIDENCE_SCORE = 0.6;
const MAX_PRIMARY_SUBJECTS = 2;

// Engineering weights from the supervised G-drive culling bench; rerun the bench before retuning.
const SUBJECT_RANK_WEIGHTS = {
  size: 0.24,
  center: 0.2,
  lookAtCamera: 0.18,
  sharpness: 0.16,
  faceQuality: 0.1,
  cropSafety: 0.07,
  poseReliability: 0.05,
} as const;

const LOOK_AT_CAMERA_WEIGHTS = {
  eyeReliability: 0.48,
  poseReliability: 0.42,
  landmarkReadyBonus: 0.1,
} as const;

export function rankSubjects(inputs: SubjectRankInput[]): SubjectRanking {
  const base = inputs.map(input => scoreSubject(input));
  const withOccluders = markOccluders(base);
  const eligible = withOccluders
    .filter(face => face.eligibleAsPrimary && face.subjectRole !== 'OCCLUDER')
    .sort((a, b) => b.subjectScore - a.subjectScore);
  const primary: RankedSubject[] = [];
  const top = eligible[0];

  if (top && top.subjectScore >= PRIMARY_SCORE_MIN) {
    primary.push(top);
    const second = eligible.find(candidate => (
      candidate.index !== top.index &&
      candidate.subjectScore >= top.subjectScore - 0.1 &&
      (candidate.faceSizeRatio ?? 0) >= (top.faceSizeRatio ?? 0) * 0.7 &&
      candidate.centerScore >= 0.45 &&
      normalizedCenterDistance(candidate, top) >= 0.08
    ));
    if (second) primary.push(second);
  }

  const primaryIndices = new Set(primary.slice(0, MAX_PRIMARY_SUBJECTS).map(face => face.index));
  const rankedFaces = withOccluders.map(face => {
    if (face.subjectRole === 'OCCLUDER') return face;
    if (primaryIndices.has(face.index)) {
      const rank = primary.findIndex(item => item.index === face.index) + 1;
      return {
        ...face,
        subjectRole: 'PRIMARY' as const,
        subjectRank: rank,
        subjectReason: rank === 1
          ? 'Highest subject score; used for formal AI decisions.'
          : 'Score is close to the top subject; treated as a co-primary subject.',
      };
    }
    if (face.eligibleAsPrimary) {
      return {
        ...face,
        subjectRole: 'SECONDARY' as const,
        subjectReason: 'Non-primary person; kept for diagnostics only and ignored for formal decisions.',
      };
    }
    return {
      ...face,
      subjectRole: 'BACKGROUND' as const,
      subjectReason: face.subjectReason || 'Face is too small, not looking toward camera, or has unreliable landmarks.',
    };
  });

  const primaryScores = primary.map(face => face.subjectScore);
  const topScore = primaryScores[0] ?? 0;
  const secondScore = eligible.find(face => !primaryIndices.has(face.index))?.subjectScore;
  const subjectConfidence = primary.length === 0
    ? (inputs.length > 0 ? 'LOW' : 'NONE')
    : topScore >= HIGH_CONFIDENCE_SCORE && (primary.length > 1 || secondScore === undefined || topScore - secondScore >= 0.08)
      ? 'HIGH'
      : 'MEDIUM';
  const subjectDecision = subjectDecisionText(primary.length, subjectConfidence);

  return {
    faces: rankedFaces,
    primaryFaceIndices: Array.from(primaryIndices),
    primarySubjectCount: primaryIndices.size,
    subjectConfidence,
    subjectDecision,
  };
}

function scoreSubject(input: SubjectRankInput): RankedSubject {
  const faceSize = input.faceSizeRatio ?? input.height;
  const sizeScore = clamp(faceSize / 0.14);
  const centerScore = centerSubjectScore(input);
  const eyeReliability = input.eyeReliability ?? 0;
  const poseReliability = input.poseReliability ?? 0;
  const lookAtCameraScore = clamp(
    eyeReliability * LOOK_AT_CAMERA_WEIGHTS.eyeReliability +
    poseReliability * LOOK_AT_CAMERA_WEIGHTS.poseReliability +
    (input.landmarkerStatus === 'OK' ? LOOK_AT_CAMERA_WEIGHTS.landmarkReadyBonus : 0)
  );
  const sharpnessScore = clamp(input.sharpnessScore ?? 0.5);
  const faceQualityScore = clamp(input.faceQualityScore ?? 0);
  const cropSafetyScore = cropSafety(input);
  const subjectScore = clamp(
    sizeScore * SUBJECT_RANK_WEIGHTS.size +
    centerScore * SUBJECT_RANK_WEIGHTS.center +
    lookAtCameraScore * SUBJECT_RANK_WEIGHTS.lookAtCamera +
    sharpnessScore * SUBJECT_RANK_WEIGHTS.sharpness +
    faceQualityScore * SUBJECT_RANK_WEIGHTS.faceQuality +
    cropSafetyScore * SUBJECT_RANK_WEIGHTS.cropSafety +
    poseReliability * SUBJECT_RANK_WEIGHTS.poseReliability
  );
  const eligibleAsPrimary =
    input.landmarkerStatus === 'OK' &&
    faceSize >= 0.004 &&
    faceQualityScore >= 0.35 &&
    eyeReliability >= 0.2;

  return {
    ...input,
    subjectRole: 'BACKGROUND',
    subjectScore,
    lookAtCameraScore,
    centerScore,
    sizeScore,
    sharpnessScore,
    cropSafetyScore,
    eligibleAsPrimary,
    subjectReason: eligibleAsPrimary ? '' : 'Face is too small, not looking toward camera, or has unreliable landmarks.',
  };
}

function markOccluders(faces: RankedSubject[]) {
  return faces.map(face => {
    const edgeOccluder = touchesFrameEdge(face) && (face.poseReliability ?? 0) < 0.22;
    const largeUnreliableFace = (face.faceSizeRatio ?? face.height) >= 0.12 && (face.eyeReliability ?? 0) < 0.18;
    const overlappedByBetterFace = faces.some(other => (
      other.index !== face.index &&
      iou(face, other) > 0.18 &&
      other.subjectScore > face.subjectScore + 0.12 &&
      other.cropSafetyScore > face.cropSafetyScore + 0.2
    ));

    if (edgeOccluder || largeUnreliableFace || overlappedByBetterFace) {
      return {
        ...face,
        subjectRole: 'OCCLUDER' as const,
        eligibleAsPrimary: false,
        subjectReason: edgeOccluder
          ? 'Cropped near the frame edge with unreliable pose; treated as foreground occlusion.'
          : largeUnreliableFace
            ? 'Large face with unreliable eye landmarks; treated as foreground occlusion.'
            : 'Overlaps a more reliable subject and is less stable; treated as an occluder candidate.',
      };
    }

    return face;
  });
}

function centerSubjectScore(face: SubjectRankInput) {
  const cx = face.x + face.width / 2;
  const cy = face.y + face.height / 2;
  const dx = (cx - 0.5) / 0.5;
  const dy = (cy - 0.42) / 0.58;
  return clamp(1 - Math.hypot(dx, dy) / 1.15);
}

function cropSafety(face: SubjectRankInput) {
  if (touchesFrameEdge(face)) return 0.12;
  if (face.x <= 0.035 || face.y <= 0.035 || face.x + face.width >= 0.965 || face.y + face.height >= 0.965) {
    return 0.55;
  }
  return 1;
}

function touchesFrameEdge(face: SubjectRankInput) {
  return face.x <= 0.015 || face.y <= 0.015 || face.x + face.width >= 0.985 || face.y + face.height >= 0.985;
}

function normalizedCenterDistance(a: SubjectRankInput, b: SubjectRankInput) {
  const ax = a.x + a.width / 2;
  const ay = a.y + a.height / 2;
  const bx = b.x + b.width / 2;
  const by = b.y + b.height / 2;
  return Math.hypot(ax - bx, ay - by);
}

function iou(a: SubjectRankInput, b: SubjectRankInput) {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  const intersection = Math.max(0, right - left) * Math.max(0, bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;
  return union <= 0 ? 0 : intersection / union;
}

function subjectDecisionText(primaryCount: number, confidence: AiSubjectConfidence) {
  if (primaryCount === 0) return 'Subject unclear; only review hints are allowed.';
  if (confidence === 'LOW') return 'Subject unclear; only review hints are allowed.';
  return `Primary subjects: ${primaryCount}. Non-primary faces are diagnostics only.`;
}

function clamp(value: number) {
  return Math.max(0, Math.min(1, value));
}
