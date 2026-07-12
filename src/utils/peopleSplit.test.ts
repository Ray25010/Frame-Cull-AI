import { describe, expect, it } from 'vitest';
import type { PersonFaceEmbedding } from '../types';
import {
  clusterPeopleFaces,
  cosineDistance,
  createClusterFromFace,
  mergePeopleClusters,
  moveFaceToCluster,
  normalizeEmbedding,
} from './peopleSplit';

function createFace(overrides: Partial<PersonFaceEmbedding>): PersonFaceEmbedding {
  return {
    key: overrides.key ?? 'face-1',
    photoId: overrides.photoId ?? 'photo-1',
    faceIndex: overrides.faceIndex ?? 0,
    embedding: overrides.embedding ?? [1, 0, 0],
    boundingBox: overrides.boundingBox ?? { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
    confidence: overrides.confidence ?? 0.92,
    quality: overrides.quality ?? 0.82,
    source: overrides.source ?? 'SFACE',
    subjectRole: overrides.subjectRole,
    isPrimaryCandidate: overrides.isPrimaryCandidate,
    eligibleForCluster: overrides.eligibleForCluster ?? true,
    visualQuality: overrides.visualQuality,
    structureQuality: overrides.structureQuality,
    hasFaceKeypoints: overrides.hasFaceKeypoints,
    landmarkerStatus: overrides.landmarkerStatus,
    landmarkerOverlap: overrides.landmarkerOverlap,
    reason: overrides.reason,
    thumbnail: overrides.thumbnail,
  };
}

const stableFaceSample = {
  quality: 0.86,
  visualQuality: 0.62,
  structureQuality: 0.74,
  landmarkerStatus: 'OK' as const,
  landmarkerOverlap: 0.42,
};

function embeddingAtDegrees(degrees: number) {
  const radians = degrees * Math.PI / 180;
  return [Math.cos(radians), Math.sin(radians), 0];
}

describe('peopleSplit utils', () => {
  it('normalizes embeddings', () => {
    const normalized = normalizeEmbedding([3, 4]);
    expect(normalized[0]).toBeCloseTo(0.6);
    expect(normalized[1]).toBeCloseTo(0.8);
  });

  it('computes cosine distance for distinct faces', () => {
    const a = normalizeEmbedding([1, 0, 0]);
    const b = normalizeEmbedding([0, 1, 0]);
    expect(cosineDistance(a, b)).toBeCloseTo(1);
  });

  it('clusters same person faces together and keeps low quality faces unassigned', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'p1', embedding: [0.98, 0.02, 0.01], ...stableFaceSample }),
      createFace({ key: 'a2', photoId: 'p2', embedding: [0.97, 0.04, 0.02], ...stableFaceSample }),
      createFace({ key: 'b1', photoId: 'p3', embedding: [0.05, 0.96, 0.03] }),
      createFace({ key: 'tiny', photoId: 'p4', embedding: [0.99, 0.01, 0.01], quality: 0.18, eligibleForCluster: false }),
    ];

    const result = clusterPeopleFaces(faces, { threshold: 0.18 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberFaceKeys).toEqual(expect.arrayContaining(['a1', 'a2']));
    expect(result.unassignedFaces.map(face => face.key)).toContain('b1');
    expect(result.unassignedFaces.map(face => face.key)).toContain('tiny');
  });

  it('allows same photo to appear in multiple clusters', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'shared', embedding: [0.99, 0.01, 0], ...stableFaceSample }),
      createFace({ key: 'b1', photoId: 'shared', faceIndex: 1, embedding: [0.02, 0.98, 0], ...stableFaceSample }),
    ];
    const result = clusterPeopleFaces(faces, { threshold: 0.18 });
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters.every(cluster => cluster.photoIds.includes('shared'))).toBe(true);
  });

  it('does not merge two faces from the same photo into one person', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'shared', embedding: [0.99, 0.01, 0], ...stableFaceSample }),
      createFace({ key: 'a2', photoId: 'shared', faceIndex: 1, embedding: [0.98, 0.02, 0], ...stableFaceSample }),
      createFace({ key: 'a3', photoId: 'next', embedding: [0.99, 0.015, 0], ...stableFaceSample }),
    ];

    const result = clusterPeopleFaces(faces, { threshold: 0.18 });
    expect(result.clusters).toHaveLength(2);
    expect(result.clusters.some(cluster => cluster.memberFaceKeys.includes('a1') && cluster.memberFaceKeys.includes('a2'))).toBe(false);
  });

  it('post-merges split clusters for the same person across photos', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'p1', embedding: [1, 0, 0], ...stableFaceSample }),
      createFace({ key: 'a2', photoId: 'p2', embedding: [0.8, 0.6, 0], ...stableFaceSample }),
      createFace({ key: 'a3', photoId: 'p3', embedding: [0.81, 0.59, 0], ...stableFaceSample }),
    ];

    const result = clusterPeopleFaces(faces, { threshold: 0.18 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberFaceKeys).toEqual(expect.arrayContaining(['a1', 'a2', 'a3']));
  });

  it('does not merge two established people through one close bridge pair', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'a-1', embedding: embeddingAtDegrees(0), ...stableFaceSample }),
      createFace({ key: 'a2', photoId: 'a-2', embedding: embeddingAtDegrees(2), ...stableFaceSample }),
      createFace({ key: 'b1', photoId: 'b-1', embedding: embeddingAtDegrees(50), ...stableFaceSample }),
      createFace({ key: 'b2', photoId: 'b-2', embedding: embeddingAtDegrees(80), ...stableFaceSample }),
    ];

    const result = clusterPeopleFaces(faces, { threshold: 0.18 });

    expect(result.clusters).toHaveLength(2);
    expect(result.clusters.map(cluster => cluster.memberFaceKeys.sort())).toEqual(expect.arrayContaining([
      ['a1', 'a2'],
      ['b1', 'b2'],
    ]));
  });

  it('does not place a moderately similar pair in the same automatic cluster', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'a-1', embedding: embeddingAtDegrees(0), ...stableFaceSample }),
      createFace({ key: 'b1', photoId: 'b-1', embedding: embeddingAtDegrees(44), ...stableFaceSample }),
    ];

    const result = clusterPeopleFaces(faces);

    expect(result.clusters.some(cluster => (
      cluster.memberFaceKeys.includes('a1') && cluster.memberFaceKeys.includes('b1')
    ))).toBe(false);
  });

  it('does not let an early weak pair consume a later strong match', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'a-1', embedding: embeddingAtDegrees(0), ...stableFaceSample, quality: 0.99 }),
      createFace({ key: 'b1', photoId: 'b-1', embedding: embeddingAtDegrees(44), ...stableFaceSample, quality: 0.98 }),
      createFace({ key: 'a2', photoId: 'a-2', embedding: embeddingAtDegrees(-10), ...stableFaceSample, quality: 0.97 }),
    ];

    const result = clusterPeopleFaces(faces);
    const aCluster = result.clusters.find(cluster => cluster.memberFaceKeys.includes('a1'));

    expect(aCluster?.memberFaceKeys).toEqual(expect.arrayContaining(['a1', 'a2']));
    expect(aCluster?.memberFaceKeys).not.toContain('b1');
  });

  it('keeps a corroborated three-face identity cluster', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'a-1', embedding: embeddingAtDegrees(0), ...stableFaceSample }),
      createFace({ key: 'a2', photoId: 'a-2', embedding: embeddingAtDegrees(44), ...stableFaceSample }),
      createFace({ key: 'a3', photoId: 'a-3', embedding: embeddingAtDegrees(10), ...stableFaceSample }),
    ];

    const result = clusterPeopleFaces(faces);

    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberFaceKeys).toEqual(expect.arrayContaining(['a1', 'a2', 'a3']));
  });

  it('requires two representative members before extending an established cluster', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'a-1', embedding: embeddingAtDegrees(0), ...stableFaceSample }),
      createFace({ key: 'a2', photoId: 'a-2', embedding: embeddingAtDegrees(20), ...stableFaceSample }),
      createFace({ key: 'bridge', photoId: 'b-1', embedding: embeddingAtDegrees(55), ...stableFaceSample }),
    ];

    const result = clusterPeopleFaces(faces);

    expect(result.clusters).toHaveLength(2);
    const established = result.clusters.find(cluster => cluster.memberFaceKeys.includes('a1'));
    expect(established?.memberFaceKeys).toEqual(expect.arrayContaining(['a1', 'a2']));
    expect(established?.memberFaceKeys).not.toContain('bridge');
    expect(result.clusters.some(cluster => cluster.memberFaceKeys.length === 1 && cluster.memberFaceKeys[0] === 'bridge')).toBe(true);
  });

  it('keeps a face unassigned when two people are almost equally plausible', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'a-1', embedding: embeddingAtDegrees(0), ...stableFaceSample }),
      createFace({ key: 'b1', photoId: 'b-1', embedding: embeddingAtDegrees(50), ...stableFaceSample }),
      createFace({ key: 'a2', photoId: 'a-2', embedding: embeddingAtDegrees(2), ...stableFaceSample }),
      createFace({ key: 'b2', photoId: 'b-2', embedding: embeddingAtDegrees(52), ...stableFaceSample }),
      createFace({ key: 'ambiguous', photoId: 'x-1', embedding: embeddingAtDegrees(25), ...stableFaceSample }),
    ];

    const result = clusterPeopleFaces(faces, { threshold: 0.30 });

    expect(result.clusters).toHaveLength(2);
    expect(result.clusters.some(cluster => cluster.memberFaceKeys.includes('ambiguous'))).toBe(false);
    expect(result.unassignedFaces.map(face => face.key)).toContain('ambiguous');
  });

  it('keeps weak one-off detections unassigned instead of creating hundreds of people', () => {
    const faces = [
      createFace({ key: 'bag', photoId: 'p1', embedding: [0.3, 0.3, 0.2], quality: 0.52, visualQuality: 0.31, structureQuality: 0.47 }),
      createFace({ key: 'blur', photoId: 'p2', embedding: [0.2, 0.4, 0.2], quality: 0.66, visualQuality: 0.33, structureQuality: 0.48 }),
    ];

    const result = clusterPeopleFaces(faces, { threshold: 0.18 });
    expect(result.clusters).toHaveLength(0);
    expect(result.unassignedFaces.map(face => face.key)).toEqual(expect.arrayContaining(['bag', 'blur']));
  });

  it('merges clusters into the chosen target', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'p1', embedding: [0.99, 0.01, 0], ...stableFaceSample }),
      createFace({ key: 'a2', photoId: 'p2', embedding: [0.98, 0.02, 0], ...stableFaceSample }),
      createFace({ key: 'b1', photoId: 'p3', embedding: [0.01, 0.99, 0], ...stableFaceSample }),
    ];
    const { clusters } = clusterPeopleFaces(faces, { threshold: 0.18 });
    const merged = mergePeopleClusters(clusters, [clusters[1].id], clusters[0].id, faces);
    expect(merged).toHaveLength(1);
    expect(merged[0].memberFaceKeys).toEqual(expect.arrayContaining(['a1', 'a2', 'b1']));
    expect(merged[0].status).toBe('MERGED');
  });

  it('moves a face between clusters', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'p1', embedding: [0.99, 0.01, 0], ...stableFaceSample }),
      createFace({ key: 'b1', photoId: 'p2', embedding: [0.01, 0.99, 0], ...stableFaceSample }),
      createFace({ key: 'c1', photoId: 'p3', embedding: [0.02, 0.98, 0], ...stableFaceSample }),
    ];
    const { clusters } = clusterPeopleFaces(faces, { threshold: 0.18 });
    const source = clusters.find(cluster => cluster.memberFaceKeys.includes('c1'));
    const target = clusters.find(cluster => cluster.memberFaceKeys.includes('a1'));
    expect(source && target).toBeTruthy();

    const moved = moveFaceToCluster(clusters, 'c1', target!.id, faces);
    expect(moved.find(cluster => cluster.id === target!.id)?.memberFaceKeys).toContain('c1');
  });

  it('creates a new person cluster from a single face', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'p1', embedding: [0.99, 0.01, 0], ...stableFaceSample }),
      createFace({ key: 'a2', photoId: 'p2', embedding: [0.98, 0.02, 0], ...stableFaceSample }),
    ];
    const { clusters } = clusterPeopleFaces(faces, { threshold: 0.18 });
    const split = createClusterFromFace(clusters, 'a2', faces);

    expect(split).toHaveLength(2);
    expect(split.find(cluster => cluster.memberFaceKeys.includes('a2'))?.memberFaceKeys).toEqual(['a2']);
    expect(split.find(cluster => cluster.memberFaceKeys.includes('a2'))?.status).toBe('SPLIT');
  });

  it('keeps a moved face owned by one cluster only', () => {
    const faces = [
      createFace({ key: 'a1', photoId: 'p1', embedding: [0.99, 0.01, 0], ...stableFaceSample }),
      createFace({ key: 'b1', photoId: 'p2', embedding: [0.01, 0.99, 0], ...stableFaceSample }),
    ];
    const { clusters } = clusterPeopleFaces(faces, { threshold: 0.18 });
    const moved = moveFaceToCluster(clusters, 'b1', clusters[0].id, faces);
    const ownershipCount = moved.reduce((count, cluster) => (
      count + (cluster.memberFaceKeys.includes('b1') ? 1 : 0)
    ), 0);

    expect(ownershipCount).toBe(1);
  });

  it('keeps blurry and fallback identity samples out of automatic person groups', () => {
    const faces = [
      createFace({ key: 'sharp', photoId: 'p1', embedding: [0.99, 0.01, 0], visualQuality: 0.62, structureQuality: 0.74, landmarkerStatus: 'OK', landmarkerOverlap: 0.38 }),
      createFace({ key: 'blurry', photoId: 'p2', embedding: [0.98, 0.02, 0], visualQuality: 0.1, structureQuality: 0.72 }),
      createFace({ key: 'fallback', photoId: 'p3', embedding: [0.97, 0.03, 0], source: 'FALLBACK', visualQuality: 0.7, structureQuality: 0.72 }),
    ];

    const result = clusterPeopleFaces(faces, { threshold: 0.18 });
    expect(result.clusters).toHaveLength(1);
    expect(result.clusters[0].memberFaceKeys).toEqual(['sharp']);
    expect(result.unassignedFaces.map(face => face.key)).toEqual(expect.arrayContaining(['blurry', 'fallback']));
  });

  it('keeps clustering bounded on large batches', () => {
    const faces = Array.from({ length: 480 }, (_, index) => {
      const person = index % 120;
      const angle = person * 0.021;
      return createFace({
        key: `large-${index}`,
        photoId: `p-${index}`,
        embedding: [
          Math.cos(angle),
          Math.sin(angle),
          (index % 4) * 0.002,
        ],
        ...stableFaceSample,
      });
    });

    const started = performance.now();
    const result = clusterPeopleFaces(faces, { threshold: 0.18 });
    const elapsedMs = performance.now() - started;

    expect(result.faces).toHaveLength(faces.length);
    expect(result.clusters.length).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThan(1500);
  });
});
