import { describe, expect, it } from 'vitest';
import {
  createEnhancedFaceDetectionRegions,
  mapFaceBoxFromRegion,
  mergeFaceBoxes,
  shouldRunEnhancedFaceDetection,
  type DetectionRegion,
  type FaceBox,
} from './faceDetectionGeometry';

describe('face detection geometry', () => {
  it('keeps the highest-confidence box when detections overlap', () => {
    const boxes: FaceBox[] = [
      { x: 100, y: 100, width: 80, height: 100, confidence: 0.55, source: 'tile' },
      { x: 108, y: 108, width: 78, height: 98, confidence: 0.9, source: 'full' },
      { x: 400, y: 120, width: 60, height: 80, confidence: 0.65, source: 'full' },
    ];

    const merged = mergeFaceBoxes(boxes, 0.35, 10);

    expect(merged).toHaveLength(2);
    expect(merged.some(box => box.confidence === 0.9)).toBe(true);
    expect(merged.some(box => box.confidence === 0.55)).toBe(false);
  });

  it('maps tile detection coordinates back to the full image', () => {
    const region: DetectionRegion = { x: 500, y: 300, width: 600, height: 400, source: 'tile' };
    const mapped = mapFaceBoxFromRegion(
      { x: 100, y: 50, width: 60, height: 80, confidence: 0.7, source: 'full' },
      region,
      300,
      200,
      1600,
      1000,
    );

    expect(mapped.x).toBe(700);
    expect(mapped.y).toBe(400);
    expect(mapped.width).toBe(120);
    expect(mapped.height).toBe(160);
    expect(mapped.source).toBe('tile');
  });

  it('creates overlapping enhancement regions including a center crop', () => {
    const regions = createEnhancedFaceDetectionRegions(2000, 1200);

    expect(regions.length).toBeGreaterThanOrEqual(5);
    expect(regions.some(region => region.source === 'center')).toBe(true);
    expect(regions.every(region => region.width > 0 && region.height > 0)).toBe(true);
  });

  it('runs enhancement when no face or only tiny faces are detected', () => {
    expect(shouldRunEnhancedFaceDetection([], 2200, 1400)).toBe(true);
    expect(shouldRunEnhancedFaceDetection([
      { x: 400, y: 300, width: 40, height: 60, confidence: 0.8, source: 'full' },
    ], 2200, 1400)).toBe(true);
    expect(shouldRunEnhancedFaceDetection([
      { x: 400, y: 300, width: 180, height: 220, confidence: 0.8, source: 'full' },
    ], 2200, 1400)).toBe(false);
  });
});
