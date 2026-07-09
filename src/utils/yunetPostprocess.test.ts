import { describe, expect, it } from 'vitest';
import { decodeYuNetOutputs, type YuNetOutputMap } from './yunetPostprocess';

describe('YuNet postprocess', () => {
  it('decodes stride outputs back to image coordinates', () => {
    const outputs = emptyOutputs();
    const row = 10;
    const col = 20;
    const index = row * 80 + col;
    outputs.cls_8.data[index] = 0.81;
    outputs.obj_8.data[index] = 1;
    outputs.bbox_8.data[index * 4] = 0.5;
    outputs.bbox_8.data[index * 4 + 1] = 0.5;
    outputs.bbox_8.data[index * 4 + 2] = Math.log(10);
    outputs.bbox_8.data[index * 4 + 3] = Math.log(12);

    const boxes = decodeYuNetOutputs(outputs, {
      sourceWidth: 640,
      sourceHeight: 640,
      inputSize: 640,
      scale: 1,
      offsetX: 0,
      offsetY: 0,
    }, 0.5);

    expect(boxes).toHaveLength(1);
    expect(boxes[0].confidence).toBeCloseTo(0.9, 3);
    expect(boxes[0].x).toBeCloseTo(124, 3);
    expect(boxes[0].y).toBeCloseTo(36, 3);
    expect(boxes[0].width).toBeCloseTo(80, 3);
    expect(boxes[0].height).toBeCloseTo(96, 3);
  });

  it('undoes letterbox padding and scale', () => {
    const outputs = emptyOutputs();
    const row = 20;
    const col = 40;
    const index = row * 80 + col;
    outputs.cls_8.data[index] = 1;
    outputs.obj_8.data[index] = 1;
    outputs.bbox_8.data[index * 4] = 0.5;
    outputs.bbox_8.data[index * 4 + 1] = 0.5;
    outputs.bbox_8.data[index * 4 + 2] = Math.log(8);
    outputs.bbox_8.data[index * 4 + 3] = Math.log(8);

    const boxes = decodeYuNetOutputs(outputs, {
      sourceWidth: 1280,
      sourceHeight: 640,
      inputSize: 640,
      scale: 0.5,
      offsetX: 0,
      offsetY: 160,
    }, 0.5);

    expect(boxes).toHaveLength(1);
    expect(boxes[0].x).toBeCloseTo(584, 3);
    expect(boxes[0].y).toBeCloseTo(-56, 3);
    expect(boxes[0].width).toBeCloseTo(128, 3);
  });
});

function emptyOutputs(): YuNetOutputMap {
  return {
    cls_8: { data: new Float32Array(6400) },
    cls_16: { data: new Float32Array(1600) },
    cls_32: { data: new Float32Array(400) },
    obj_8: { data: new Float32Array(6400) },
    obj_16: { data: new Float32Array(1600) },
    obj_32: { data: new Float32Array(400) },
    bbox_8: { data: new Float32Array(6400 * 4) },
    bbox_16: { data: new Float32Array(1600 * 4) },
    bbox_32: { data: new Float32Array(400 * 4) },
    kps_8: { data: new Float32Array(6400 * 10) },
    kps_16: { data: new Float32Array(1600 * 10) },
    kps_32: { data: new Float32Array(400 * 10) },
  };
}
