import type { PeopleFaceBox, PersonCluster, PersonFaceEmbedding } from '../types';

export const PEOPLE_SPLIT_MODEL_VERSION = 'people-split-v3-sface-rgb';
export const PEOPLE_CLUSTER_THRESHOLD = 0.32;
export const PEOPLE_CLUSTER_SECONDARY_THRESHOLD = 0.32;
const PEOPLE_CLUSTER_MIN_QUALITY = 0.48;
const PEOPLE_CLUSTER_MIN_SINGLE_QUALITY = 0.70;
const PEOPLE_CLUSTER_AMBIGUITY_MARGIN = 0.05;
const PEOPLE_CLUSTER_SEED_THRESHOLD = 0.26;
const PEOPLE_CLUSTER_STRONG_PAIR_THRESHOLD = 0.26;
const PEOPLE_CLUSTER_SUPPORT_THRESHOLD = 0.32;
const PEOPLE_CLUSTER_POST_MERGE_THRESHOLD = 0.32;

export interface ClusterPeopleOptions {
  threshold?: number;
  minQuality?: number;
}

export function normalizeEmbedding(embedding: number[]) {
  const norm = Math.hypot(...embedding);
  if (!Number.isFinite(norm) || norm <= 0) return embedding.map(() => 0);
  return embedding.map(value => value / norm);
}

export function cosineSimilarity(a: number[], b: number[]) {
  const length = Math.min(a.length, b.length);
  if (length === 0) return 0;
  let dot = 0;
  let aNorm = 0;
  let bNorm = 0;
  for (let index = 0; index < length; index += 1) {
    const av = a[index] ?? 0;
    const bv = b[index] ?? 0;
    dot += av * bv;
    aNorm += av * av;
    bNorm += bv * bv;
  }
  const denom = Math.sqrt(aNorm) * Math.sqrt(bNorm);
  return denom <= 0 ? 0 : dot / denom;
}

export function cosineDistance(a: number[], b: number[]) {
  return 1 - cosineSimilarity(a, b);
}

export function clusterPeopleFaces(
  faces: PersonFaceEmbedding[],
  options: ClusterPeopleOptions = {},
) {
  const threshold = options.threshold ?? PEOPLE_CLUSTER_THRESHOLD;
  const minQuality = options.minQuality ?? PEOPLE_CLUSTER_MIN_QUALITY;
  const reviewedFaces = faces.map(face => {
    const reason = peopleFaceReliabilityRejectReason(face, minQuality);
    return reason
      ? { ...face, eligibleForCluster: false, reason: face.reason ?? reason }
      : { ...face, eligibleForCluster: true };
  });
  const reviewedFaceByKey = new Map(reviewedFaces.map(face => [face.key, face]));
  const eligibleFaces = reviewedFaces
    .filter(face => face.eligibleForCluster && face.quality >= minQuality && face.embedding.length > 0)
    .map(face => ({ ...face, embedding: normalizeEmbedding(face.embedding) }))
    .sort((a, b) => b.quality - a.quality);
  const unassignedFaces = reviewedFaces.filter(face => (
    !face.eligibleForCluster || face.quality < minQuality || face.embedding.length === 0
  ));
  const ambiguousFaces: PersonFaceEmbedding[] = [];
  const groups: Array<{
    id: string;
    centroid: number[];
    faces: PersonFaceEmbedding[];
    qualitySum: number;
    photoIds: Set<string>;
  }> = [];

  eligibleFaces.forEach(face => {
    let bestIndex = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    let bestThreshold = threshold;
    let secondBestDistance = Number.POSITIVE_INFINITY;

    // Check every current group, but keep photo membership indexed so large sets
    // do not spend most of their time scanning group members repeatedly.
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      if (group.photoIds.has(face.photoId)) continue;
      const distance = cosineDistance(face.embedding, group.centroid);
      const thresholdForGroup = mergeThresholdFor(face, group.faces, threshold);
      if (distance < bestDistance) {
        secondBestDistance = bestDistance;
        bestDistance = distance;
        bestIndex = index;
        bestThreshold = thresholdForGroup;
      } else if (distance < secondBestDistance) {
        secondBestDistance = distance;
      }
    }

    const isAmbiguous = bestDistance <= bestThreshold
      && hasRepresentativeSupport(face, groups[bestIndex]?.faces ?? [])
      && secondBestDistance - bestDistance < PEOPLE_CLUSTER_AMBIGUITY_MARGIN;
    if (isAmbiguous) {
      ambiguousFaces.push({
        ...face,
        eligibleForCluster: false,
        reason: face.reason ?? 'Identity match is ambiguous between multiple people',
      });
    } else if (
      bestIndex >= 0
      && bestDistance <= bestThreshold
      && hasRepresentativeSupport(face, groups[bestIndex].faces)
    ) {
      const group = groups[bestIndex];
      group.faces.push(face);
      group.photoIds.add(face.photoId);
      group.qualitySum += Math.max(0.01, face.quality);
      group.centroid = weightedCentroid(group.faces);
    } else {
      groups.push({
        id: `person-${groups.length + 1}`,
        centroid: [...face.embedding],
        faces: [face],
        qualitySum: Math.max(0.01, face.quality),
        photoIds: new Set([face.photoId]),
      });
    }
  });

  const preliminaryClusters = groups
    .filter(group => group.faces.length > 0)
    .sort((a, b) => b.faces.length - a.faces.length || b.qualitySum - a.qualitySum)
    .map((group, index) => buildClusterFromFaces(
      `person-${index + 1}`,
      index,
      group.faces,
      'AUTO',
    ))
    .map(cluster => enforceClusterPhotoUniqueness(cluster, eligibleFaces))
    .map(cluster => rebuildCluster(cluster, eligibleFaces, cluster.status))
    .filter(cluster => cluster.faceCount > 0);
  const mergedClusters = postMergeSimilarClusters(preliminaryClusters, eligibleFaces);
  const { clusters, rejectedFaces } = filterWeakAutoClusters(mergedClusters, reviewedFaceByKey);

  return {
    clusters: dedupeClusterFaceMembership(clusters, eligibleFaces),
    unassignedFaces: dedupeFaces([...unassignedFaces, ...ambiguousFaces, ...rejectedFaces]),
    faces: reviewedFaces,
  };
}

export function createClusterFromFace(
  clusters: PersonCluster[],
  faceKey: string,
  faces: PersonFaceEmbedding[],
) {
  const targetFace = faces.find(face => face.key === faceKey);
  if (!targetFace) return clusters;

  const nextId = nextPersonClusterId(clusters);
  const nextIndex = Number(nextId.match(/\d+/)?.[0] ?? clusters.length + 1) - 1;
  const existingClusters = clusters
    .map(cluster => ({
      ...cluster,
      memberFaceKeys: cluster.memberFaceKeys.filter(key => key !== faceKey),
      status: cluster.memberFaceKeys.includes(faceKey) ? 'SPLIT' as const : cluster.status,
    }))
    .map(cluster => rebuildCluster(cluster, faces, cluster.status))
    .filter(cluster => cluster.faceCount > 0);
  const newCluster = buildClusterFromFaces(nextId, Math.max(0, nextIndex), [targetFace], 'SPLIT');

  return [...existingClusters, newCluster];
}

export function rebuildCluster(
  cluster: PersonCluster,
  faces: PersonFaceEmbedding[],
  status: PersonCluster['status'] = cluster.status,
): PersonCluster {
  const memberSet = new Set(cluster.memberFaceKeys);
  const memberFaces = faces.filter(face => memberSet.has(face.key));
  const fallbackIndex = Number(cluster.id.match(/\d+/)?.[0] ?? 1) - 1;
  const next = buildClusterFromFaces(cluster.id, Math.max(0, fallbackIndex), memberFaces, status);
  return {
    ...next,
    displayName: cluster.displayName,
  };
}

export function mergePeopleClusters(
  clusters: PersonCluster[],
  sourceIds: string[],
  targetId: string,
  faces: PersonFaceEmbedding[],
) {
  const sourceSet = new Set(sourceIds.filter(id => id !== targetId));
  const target = clusters.find(cluster => cluster.id === targetId);
  if (!target) return clusters;

  const mergedKeys = new Set(target.memberFaceKeys);
  clusters.forEach(cluster => {
    if (sourceSet.has(cluster.id)) {
      cluster.memberFaceKeys.forEach(key => mergedKeys.add(key));
    }
  });

  return dedupeClusterFaceMembership(clusters
    .filter(cluster => !sourceSet.has(cluster.id))
    .map(cluster => {
      if (cluster.id !== targetId) return cluster;
      return rebuildCluster({
        ...cluster,
        memberFaceKeys: Array.from(mergedKeys),
        status: 'MERGED',
      }, faces, 'MERGED');
    }), faces);
}

export function moveFaceToCluster(
  clusters: PersonCluster[],
  faceKey: string,
  targetClusterId: string | 'UNASSIGNED',
  faces: PersonFaceEmbedding[],
) {
  let nextClusters = clusters.map(cluster => ({
    ...cluster,
    memberFaceKeys: cluster.memberFaceKeys.filter(key => key !== faceKey),
  }));

  if (targetClusterId !== 'UNASSIGNED') {
    nextClusters = nextClusters.map(cluster => {
      if (cluster.id !== targetClusterId) return cluster;
      return {
        ...cluster,
        memberFaceKeys: Array.from(new Set([...cluster.memberFaceKeys, faceKey])),
        status: 'SPLIT' as const,
      };
    });
  }

  return dedupeClusterFaceMembership(nextClusters
    .map(cluster => rebuildCluster(cluster, faces, cluster.status))
    .filter(cluster => cluster.faceCount > 0), faces);
}

export function faceQualityFromBox(box: PeopleFaceBox, confidence: number, imageWidth: number, imageHeight: number) {
  const shortEdge = Math.max(1, Math.min(imageWidth, imageHeight));
  const faceRatio = Math.max(box.width, box.height) / shortEdge;
  const sizeScore = clamp01(faceRatio / 0.11);
  const confidenceScore = clamp01((confidence - 0.32) / 0.58);
  const cropScore = cropSafetyScore(box, imageWidth, imageHeight);
  return clamp01(sizeScore * 0.42 + confidenceScore * 0.38 + cropScore * 0.2);
}

export function isUsablePeopleFace(box: PeopleFaceBox, confidence: number, imageWidth: number, imageHeight: number) {
  const shortEdge = Math.max(1, Math.min(imageWidth, imageHeight));
  const faceRatio = Math.max(box.width, box.height) / shortEdge;
  const cropScore = cropSafetyScore(box, imageWidth, imageHeight);
  if (confidence < 0.4) return { displayable: false, eligible: false, reason: '检测置信度较低' };
  if (faceRatio < 0.022) return { displayable: false, eligible: false, reason: '人脸过小' };
  if (cropScore < 0.18) return { displayable: false, eligible: false, reason: '边缘裁切较多' };
  if (confidence < 0.48) return { displayable: true, eligible: false, reason: '检测置信度不足以自动入组' };
  if (faceRatio < 0.028) return { displayable: true, eligible: false, reason: '人脸样本过小' };
  if (cropScore < 0.32) return { displayable: true, eligible: false, reason: '人脸裁切过多' };
  return { displayable: true, eligible: true };
}

export function peopleFaceReliabilityRejectReason(face: PersonFaceEmbedding, minQuality = PEOPLE_CLUSTER_MIN_QUALITY) {
  if (!face.eligibleForCluster) return face.reason ?? '???????';
  if (face.source !== 'SFACE') return '?????????????';
  if (face.embedding.length === 0) return '??????';
  if (face.confidence < 0.56) return '????????????';
  if (face.quality < minQuality) return '???????????';
  if (typeof face.visualQuality === 'number' && face.visualQuality < 0.30) return '????????????';
  if (face.hasFaceKeypoints === false) return '?????????';
  if (typeof face.structureQuality === 'number' && face.structureQuality < 0.46) return '?????????';
  const normalizedFaceSize = Math.max(face.boundingBox.width, face.boundingBox.height);
  if (normalizedFaceSize < 0.026) return '??????';
  return null;
}

function buildClusterFromFaces(
  id: string,
  index: number,
  faces: PersonFaceEmbedding[],
  status: PersonCluster['status'],
): PersonCluster {
  const sortedFaces = [...faces].sort((a, b) => b.quality - a.quality);
  const cover = sortedFaces[0];
  const photoIds = Array.from(new Set(faces.map(face => face.photoId)));

  return {
    id,
    displayName: `人物 ${index + 1}`,
    coverPhotoId: cover?.photoId ?? '',
    coverFaceKey: cover?.key,
    memberFaceKeys: sortedFaces.map(face => face.key),
    photoIds,
    faceCount: sortedFaces.length,
    photoCount: photoIds.length,
    status,
  };
}

function weightedCentroid(faces: PersonFaceEmbedding[]) {
  const length = faces[0]?.embedding.length ?? 0;
  const result = new Array(length).fill(0);
  let totalWeight = 0;
  faces.forEach(face => {
    const weight = Math.max(0.01, face.quality);
    totalWeight += weight;
    for (let index = 0; index < length; index += 1) {
      result[index] += (face.embedding[index] ?? 0) * weight;
    }
  });
  if (totalWeight <= 0) return result;
  return normalizeEmbedding(result.map(value => value / totalWeight));
}

function mergeThresholdFor(face: PersonFaceEmbedding, groupFaces: PersonFaceEmbedding[], threshold: number) {
  const hasFallback = face.source === 'FALLBACK' || groupFaces.some(groupFace => groupFace.source === 'FALLBACK');
  if (hasFallback) return Math.min(threshold, 0.18);
  if (groupFaces.length <= 1) return Math.min(threshold, PEOPLE_CLUSTER_SEED_THRESHOLD);
  return Math.min(threshold, PEOPLE_CLUSTER_SECONDARY_THRESHOLD);
}

function hasRepresentativeSupport(face: PersonFaceEmbedding, groupFaces: PersonFaceEmbedding[]) {
  if (groupFaces.length <= 1) return true;
  const requiredSupport = Math.min(2, groupFaces.length);
  let support = 0;
  for (const groupFace of groupFaces) {
    if (cosineDistance(face.embedding, groupFace.embedding) > PEOPLE_CLUSTER_SUPPORT_THRESHOLD) continue;
    support += 1;
    if (support >= requiredSupport) return true;
  }
  return false;
}

function postMergeSimilarClusters(
  clusters: PersonCluster[],
  faces: PersonFaceEmbedding[],
) {
  const faceMap = new Map(faces.map(face => [face.key, face]));
  let next = clusters.map(cluster => rebuildCluster(cluster, faces, cluster.status));
  let changed = true;
  let pass = 0;
  const maxPasses = Math.min(12, Math.max(1, Math.ceil(Math.log2(next.length + 1)) + 4));
  const mergeThreshold = PEOPLE_CLUSTER_POST_MERGE_THRESHOLD;

  while (changed && pass < maxPasses) {
    changed = false;
    pass += 1;
    const candidates: Array<{ leftIndex: number; rightIndex: number; distance: number }> = [];

    for (let leftIndex = 0; leftIndex < next.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < next.length; rightIndex += 1) {
        const left = next[leftIndex];
        const right = next[rightIndex];
        if (!canMergeClusters(left, right)) continue;
        const distance = clusterDistance(left, right, faceMap, mergeThreshold);
        if (distance > mergeThreshold) continue;
        candidates.push({ leftIndex, rightIndex, distance });
      }
    }

    if (candidates.length === 0) break;
    candidates.sort((left, right) => left.distance - right.distance);

    const used = new Set<number>();
    const selected = new Map<number, number>();
    for (const candidate of candidates) {
      if (used.has(candidate.leftIndex) || used.has(candidate.rightIndex)) continue;
      used.add(candidate.leftIndex);
      used.add(candidate.rightIndex);
      selected.set(candidate.leftIndex, candidate.rightIndex);
    }

    if (selected.size === 0) break;
    next = next.flatMap((cluster, index) => {
      const rightIndex = selected.get(index);
      if (rightIndex !== undefined) {
        const right = next[rightIndex];
        const merged = rebuildCluster({
          ...cluster,
          memberFaceKeys: Array.from(new Set([...cluster.memberFaceKeys, ...right.memberFaceKeys])),
          status: cluster.status === 'AUTO' && right.status === 'AUTO' ? 'AUTO' : 'MERGED',
        }, faces, cluster.status === 'AUTO' && right.status === 'AUTO' ? 'AUTO' : 'MERGED');
        changed = true;
        return [merged];
      }
      return used.has(index) ? [] : [cluster];
    });
  }

  return next
    .map(cluster => enforceClusterPhotoUniqueness(cluster, faces))
    .map(cluster => rebuildCluster(cluster, faces, cluster.status))
    .filter(cluster => cluster.faceCount > 0);
}

function filterWeakAutoClusters(
  clusters: PersonCluster[],
  faceMap: Map<string, PersonFaceEmbedding>,
) {
  const kept: PersonCluster[] = [];
  const rejectedFaces: PersonFaceEmbedding[] = [];

  clusters.forEach(cluster => {
    const memberFaces = cluster.memberFaceKeys
      .map(key => faceMap.get(key))
      .filter((face): face is PersonFaceEmbedding => Boolean(face));
    const stableFaceCount = memberFaces.filter(isStableClusterFace).length;
    const bestQuality = memberFaces.reduce((best, face) => Math.max(best, face.quality), 0);
    const bestVisualQuality = memberFaces.reduce((best, face) => Math.max(best, face.visualQuality ?? 0), 0);
    const confirmedFaceCount = memberFaces.filter(hasPeopleFaceConfirmation).length;
    const hasGuidance = memberFaces.some(face => face.landmarkerStatus !== undefined || typeof face.landmarkerOverlap === 'number');
    const manualCluster = cluster.status !== 'AUTO';
    const multiSampleCluster = cluster.faceCount >= 2
      && hasAutomaticClusterIdentitySupport(memberFaces)
      && stableFaceCount >= Math.min(2, cluster.faceCount)
      && bestQuality >= 0.68
      && bestVisualQuality >= 0.38
      && (!hasGuidance || confirmedFaceCount >= Math.min(2, cluster.faceCount));
    const strongSingleton = cluster.faceCount === 1
      && stableFaceCount >= 1
      && bestQuality >= PEOPLE_CLUSTER_MIN_SINGLE_QUALITY
      && bestVisualQuality >= 0.42
      && confirmedFaceCount >= 1;
    const shouldKeep = manualCluster
      || multiSampleCluster
      || strongSingleton;

    if (shouldKeep) {
      if (manualCluster) {
        kept.push(cluster);
        return;
      }
      kept.push(cluster);
    } else {
      rejectedFaces.push(...memberFaces.map(face => ({
        ...face,
        eligibleForCluster: false,
        reason: face.reason ?? '单张弱样本，保留为未归类候选',
      })));
    }
  });

  return { clusters: kept, rejectedFaces };
}

function isStableClusterFace(face: PersonFaceEmbedding) {
  return face.source === 'SFACE'
    && face.quality >= PEOPLE_CLUSTER_MIN_QUALITY
    && (face.visualQuality ?? 1) >= 0.30
    && (face.structureQuality ?? 1) >= 0.46
    && face.hasFaceKeypoints !== false
    && face.confidence >= 0.56;
}

function hasPeopleFaceConfirmation(face: PersonFaceEmbedding) {
  if (face.isPrimaryCandidate) return true;
  return face.landmarkerStatus === 'OK' && (face.landmarkerOverlap ?? 0) >= 0.08;
}

function hasAutomaticClusterIdentitySupport(faces: PersonFaceEmbedding[]) {
  if (faces.length <= 1) return true;
  if (faces.length === 2) {
    return cosineDistance(faces[0].embedding, faces[1].embedding) <= PEOPLE_CLUSTER_STRONG_PAIR_THRESHOLD;
  }
  return faces.every((face, faceIndex) => {
    let support = 0;
    for (let otherIndex = 0; otherIndex < faces.length; otherIndex += 1) {
      if (otherIndex === faceIndex) continue;
      if (cosineDistance(face.embedding, faces[otherIndex].embedding) > PEOPLE_CLUSTER_SUPPORT_THRESHOLD) continue;
      support += 1;
      if (support >= 2) return true;
    }
    return false;
  });
}

function canMergeClusters(left: PersonCluster, right: PersonCluster) {
  const leftPhotos = new Set(left.photoIds);
  return !right.photoIds.some(photoId => leftPhotos.has(photoId));
}

function clusterDistance(
  left: PersonCluster,
  right: PersonCluster,
  faceMap: Map<string, PersonFaceEmbedding>,
  mergeThreshold = PEOPLE_CLUSTER_POST_MERGE_THRESHOLD,
) {
  const leftFaces = left.memberFaceKeys
    .map(key => faceMap.get(key))
    .filter((face): face is PersonFaceEmbedding => Boolean(face));
  const rightFaces = right.memberFaceKeys
    .map(key => faceMap.get(key))
    .filter((face): face is PersonFaceEmbedding => Boolean(face));
  if (leftFaces.length === 0 || rightFaces.length === 0) return Number.POSITIVE_INFINITY;

  const leftCentroid = weightedCentroid(leftFaces);
  const rightCentroid = weightedCentroid(rightFaces);
  const centroidDistance = cosineDistance(leftCentroid, rightCentroid);
  if (centroidDistance > mergeThreshold) return Number.POSITIVE_INFINITY;

  if (leftFaces.length === 1 && rightFaces.length === 1) {
    return cosineDistance(leftFaces[0].embedding, rightFaces[0].embedding) <= PEOPLE_CLUSTER_STRONG_PAIR_THRESHOLD
      ? centroidDistance
      : Number.POSITIVE_INFINITY;
  }

  const leftSupport = countSupportedRepresentatives(leftFaces, rightFaces);
  const rightSupport = countSupportedRepresentatives(rightFaces, leftFaces);
  const requiredLeftSupport = Math.min(2, leftFaces.length);
  const requiredRightSupport = Math.min(2, rightFaces.length);
  return leftSupport >= requiredLeftSupport && rightSupport >= requiredRightSupport
    ? centroidDistance
    : Number.POSITIVE_INFINITY;
}

function countSupportedRepresentatives(
  sourceFaces: PersonFaceEmbedding[],
  targetFaces: PersonFaceEmbedding[],
) {
  return sourceFaces.reduce((support, sourceFace) => (
    support + (targetFaces.some(targetFace => (
      cosineDistance(sourceFace.embedding, targetFace.embedding) <= PEOPLE_CLUSTER_SUPPORT_THRESHOLD
    )) ? 1 : 0)
  ), 0);
}

function dedupeFaces(faces: PersonFaceEmbedding[]) {
  const map = new Map<string, PersonFaceEmbedding>();
  faces.forEach(face => {
    const existing = map.get(face.key);
    if (!existing || face.quality > existing.quality) map.set(face.key, face);
  });
  return Array.from(map.values());
}

function enforceClusterPhotoUniqueness(cluster: PersonCluster, faces: PersonFaceEmbedding[]) {
  const faceMap = new Map(faces.map(face => [face.key, face]));
  const bestFaceByPhoto = new Map<string, PersonFaceEmbedding>();
  cluster.memberFaceKeys.forEach(key => {
    const face = faceMap.get(key);
    if (!face) return;
    const existing = bestFaceByPhoto.get(face.photoId);
    if (!existing || face.quality > existing.quality) {
      bestFaceByPhoto.set(face.photoId, face);
    }
  });

  return {
    ...cluster,
    memberFaceKeys: Array.from(bestFaceByPhoto.values()).map(face => face.key),
  };
}

function dedupeClusterFaceMembership(clusters: PersonCluster[], faces: PersonFaceEmbedding[]) {
  const faceMap = new Map(faces.map(face => [face.key, face]));
  const ownerByFace = new Map<string, { clusterId: string; quality: number; size: number }>();

  clusters.forEach(cluster => {
    cluster.memberFaceKeys.forEach(key => {
      const face = faceMap.get(key);
      if (!face) return;
      const existing = ownerByFace.get(key);
      const current = { clusterId: cluster.id, quality: face.quality, size: cluster.faceCount };
      if (!existing || current.quality > existing.quality || (current.quality === existing.quality && current.size > existing.size)) {
        ownerByFace.set(key, current);
      }
    });
  });

  return clusters
    .map(cluster => ({
      ...cluster,
      memberFaceKeys: cluster.memberFaceKeys.filter(key => ownerByFace.get(key)?.clusterId === cluster.id),
    }))
    .map(cluster => rebuildCluster(cluster, faces, cluster.status))
    .filter(cluster => cluster.faceCount > 0);
}

export function nextPersonClusterId(clusters: PersonCluster[]) {
  const maxNumber = clusters.reduce((max, cluster) => {
    const value = Number(cluster.id.match(/\d+/)?.[0] ?? 0);
    return Number.isFinite(value) ? Math.max(max, value) : max;
  }, 0);
  return `person-${maxNumber + 1}`;
}

function cropSafetyScore(box: PeopleFaceBox, imageWidth: number, imageHeight: number) {
  const margin = Math.min(
    box.x,
    box.y,
    imageWidth - box.x - box.width,
    imageHeight - box.y - box.height,
  );
  const minFaceEdge = Math.max(1, Math.min(box.width, box.height));
  return clamp01((margin + minFaceEdge * 0.08) / (minFaceEdge * 0.18));
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}
