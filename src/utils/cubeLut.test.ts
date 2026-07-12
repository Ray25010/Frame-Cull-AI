import { describe, expect, it } from 'vitest';
import { parseCubeLut } from './cubeLut';

describe('parseCubeLut', () => {
  it('parses a 3D cube LUT with comments, title, domain and R-fastest data', () => {
    const lut = parseCubeLut([
      '# comment',
      'TITLE "Identity 2"',
      'DOMAIN_MIN 0 0 0',
      'DOMAIN_MAX 1 1 1',
      'LUT_3D_SIZE 2',
      '0 0 0',
      '1 0 0',
      '0 1 0',
      '1 1 0',
      '0 0 1',
      '1 0 1',
      '0 1 1',
      '1 1 1',
    ].join('\n'));

    expect(lut.title).toBe('Identity 2');
    expect(lut.size).toBe(2);
    expect(Array.from(lut.domainMin)).toEqual([0, 0, 0]);
    expect(Array.from(lut.domainMax)).toEqual([1, 1, 1]);
    expect(Array.from(lut.data.slice(0, 6))).toEqual([0, 0, 0, 1, 0, 0]);
  });

  it('accepts a generated 33x3D cube', () => {
    const rows = ['LUT_3D_SIZE 33'];
    for (let b = 0; b < 33; b += 1) {
      for (let g = 0; g < 33; g += 1) {
        for (let r = 0; r < 33; r += 1) {
          rows.push(`${r / 32} ${g / 32} ${b / 32}`);
        }
      }
    }

    const lut = parseCubeLut(rows.join('\n'), '33.cube');

    expect(lut.size).toBe(33);
    expect(lut.data.length).toBe(33 * 33 * 33 * 3);
  });

  it('returns readable errors for unsupported or malformed LUTs', () => {
    expect(() => parseCubeLut('0 0 0')).toThrow('缺少 LUT_3D_SIZE');
    expect(() => parseCubeLut('LUT_1D_SIZE 16')).toThrow('只支持 3D');
    expect(() => parseCubeLut('LUT_3D_SIZE 65')).toThrow('过大');
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 nope')).toThrow('无效数字');
    expect(() => parseCubeLut('LUT_3D_SIZE 2\n0 0 0')).toThrow('数据不足');
  });
});
