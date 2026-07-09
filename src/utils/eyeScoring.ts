const BLINK_ASYMMETRY_REVIEW_WEIGHT = 0.18;
const EAR_CLOSED_BASE = 0.28;
const EAR_CLOSED_RANGE = 0.12;

export function bilateralBlinkClosedScore(leftBlink: number, rightBlink: number, poseReliability = 1) {
  const left = clamp01(leftBlink);
  const right = clamp01(rightBlink);
  const bilateralEvidence = Math.min(left, right);
  const asymmetryReviewEvidence = Math.max(left, right) * Math.min(left, right) * BLINK_ASYMMETRY_REVIEW_WEIGHT;
  return applyPoseReliabilityToEyeScore(clamp01(bilateralEvidence + asymmetryReviewEvidence), poseReliability);
}

export function bilateralEarClosedScore(leftEar: number, rightEar: number, poseReliability = 1) {
  const leftClosed = clamp01((EAR_CLOSED_BASE - leftEar) / EAR_CLOSED_RANGE);
  const rightClosed = clamp01((EAR_CLOSED_BASE - rightEar) / EAR_CLOSED_RANGE);
  return applyPoseReliabilityToEyeScore(Math.min(leftClosed, rightClosed), poseReliability);
}

function applyPoseReliabilityToEyeScore(score: number, poseReliability = 1) {
  if (!Number.isFinite(score)) return 0;
  if (!Number.isFinite(poseReliability)) return score;
  if (poseReliability >= 0.45) return score;
  return score * Math.max(0.68, poseReliability / 0.45);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}
