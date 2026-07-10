export type PeopleSplitAdmission = 'AUTO_ELIGIBLE' | 'REVIEW_ONLY' | 'REJECTED';

export type PeopleSplitPrecisionFaceSummary = {
  key: string;
  admission: PeopleSplitAdmission;
  detectorConfirmed?: boolean;
  fullRangeDetectorConfirmed?: boolean;
  cropDetectorConfirmed?: boolean;
  cropLandmarkerConfirmed?: boolean;
  cropLandmarkerContentPlausible?: boolean;
  nearestDistance?: number;
};

export type PeopleSplitPrecisionRun = {
  totalMs: number;
  results: Array<{
    fileName: string;
    elapsedMs: number;
    faces: PeopleSplitPrecisionFaceSummary[];
    error?: string;
    confirmationError?: string;
    cropConfirmationError?: string;
  }>;
  clusters: Array<{
    id: string;
    memberFaceKeys: string[];
  }>;
  unassignedFaceKeys: string[];
};

export function summarizePeopleSplitPrecisionRun(run: PeopleSplitPrecisionRun) {
  const faces = run.results.flatMap(result => result.faces);
  const distances = faces
    .map(face => face.nearestDistance)
    .filter((distance): distance is number => Number.isFinite(distance))
    .sort((left, right) => left - right);

  return {
    photos: run.results.length,
    processedPhotos: run.results.filter(result => !result.error).length,
    failedPhotos: run.results.filter(result => Boolean(result.error)).length,
    detectedFaces: faces.length,
    autoEligibleFaces: faces.filter(face => face.admission === 'AUTO_ELIGIBLE').length,
    reviewOnlyFaces: faces.filter(face => face.admission === 'REVIEW_ONLY').length,
    rejectedFaces: faces.filter(face => face.admission === 'REJECTED').length,
    detectorConfirmedFaces: faces.filter(face => face.detectorConfirmed === true).length,
    detectorUnconfirmedFaces: faces.filter(face => face.detectorConfirmed === false).length,
    fullRangeDetectorConfirmedFaces: faces.filter(face => face.fullRangeDetectorConfirmed === true).length,
    confirmationFailedPhotos: run.results.filter(result => Boolean(result.confirmationError)).length,
    cropDetectorConfirmedFaces: faces.filter(face => face.cropDetectorConfirmed === true).length,
    cropLandmarkerConfirmedFaces: faces.filter(face => face.cropLandmarkerConfirmed === true).length,
    cropLandmarkerContentPlausibleFaces: faces.filter(face => face.cropLandmarkerContentPlausible === true).length,
    cropConfirmationFailedPhotos: run.results.filter(result => Boolean(result.cropConfirmationError)).length,
    clusters: run.clusters.length,
    clusteredFaces: run.clusters.reduce((total, cluster) => total + cluster.memberFaceKeys.length, 0),
    unassignedFaces: run.unassignedFaceKeys.length,
    totalMs: run.totalMs,
    distanceQuantiles: {
      p10: quantileNearestRank(distances, 0.10),
      p50: quantileNearestRank(distances, 0.50),
      p90: quantileNearestRank(distances, 0.90),
    },
  };
}

function quantileNearestRank(values: number[], quantile: number) {
  if (values.length === 0) return null;
  const rank = Math.max(1, Math.ceil(Math.max(0, Math.min(1, quantile)) * values.length));
  return values[Math.min(values.length - 1, rank - 1)];
}
