import { describe, expect, it } from 'vitest';
import { rgbaToSfaceChw } from './sfacePreprocess';

describe('SFace preprocessing', () => {
  it('matches OpenCV swapRB preprocessing by producing RGB CHW planes', () => {
    const rgba = new Uint8ClampedArray([
      11, 22, 33, 255,
      44, 55, 66, 255,
    ]);

    expect(Array.from(rgbaToSfaceChw(rgba, 2))).toEqual([
      11, 44,
      22, 55,
      33, 66,
    ]);
  });
});
