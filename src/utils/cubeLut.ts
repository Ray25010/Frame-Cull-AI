import type { CubeLut3D } from '../types';

const MAX_LUT_3D_SIZE = 64;
const MIN_LUT_3D_SIZE = 2;

export function parseCubeLut(text: string, sourceName = 'LUT'): CubeLut3D {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  let title: string | undefined;
  let size: number | undefined;
  let domainMin: [number, number, number] = [0, 0, 0];
  let domainMax: [number, number, number] = [1, 1, 1];
  const values: number[] = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] ?? '';
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const keyword = line.split(/\s+/, 1)[0]?.toUpperCase();
    if (keyword === 'TITLE') {
      title = parseTitle(line);
      continue;
    }
    if (keyword === 'DOMAIN_MIN') {
      domainMin = parseTriple(line, lineIndex, 'DOMAIN_MIN');
      continue;
    }
    if (keyword === 'DOMAIN_MAX') {
      domainMax = parseTriple(line, lineIndex, 'DOMAIN_MAX');
      continue;
    }
    if (keyword === 'LUT_1D_SIZE') {
      throw new Error(`${sourceName}: 当前版本只支持 3D .cube LUT`);
    }
    if (keyword === 'LUT_3D_SIZE') {
      const nextSize = Number(line.split(/\s+/)[1]);
      if (!Number.isInteger(nextSize)) {
        throw new Error(`${sourceName}: LUT_3D_SIZE 不是有效数字`);
      }
      if (nextSize < MIN_LUT_3D_SIZE || nextSize > MAX_LUT_3D_SIZE) {
        throw new Error(`${sourceName}: LUT 尺寸 ${nextSize} 过大，当前版本支持 2-${MAX_LUT_3D_SIZE}`);
      }
      size = nextSize;
      continue;
    }

    const numeric = line.split(/\s+/).map(Number);
    if (numeric.length >= 3 && numeric.slice(0, 3).every(Number.isFinite)) {
      values.push(numeric[0], numeric[1], numeric[2]);
      continue;
    }

    if (/^[+-]?(?:\d|\.\d)/.test(line)) {
      throw new Error(`${sourceName}: 第 ${lineIndex + 1} 行包含无效数字`);
    }
  }

  if (!size) {
    throw new Error(`${sourceName}: 缺少 LUT_3D_SIZE`);
  }

  validateDomain(domainMin, domainMax, sourceName);
  const expectedTriples = size * size * size;
  const expectedValues = expectedTriples * 3;
  if (values.length < expectedValues) {
    throw new Error(`${sourceName}: LUT 数据不足，需要 ${expectedTriples} 行 RGB 数据`);
  }

  return {
    title,
    size,
    domainMin,
    domainMax,
    data: new Float32Array(values.slice(0, expectedValues)),
  };
}

function parseTitle(line: string) {
  const quoted = line.match(/^TITLE\s+"(.*)"\s*$/i);
  if (quoted) return quoted[1]?.trim() || undefined;
  return line.replace(/^TITLE\s+/i, '').trim() || undefined;
}

function parseTriple(line: string, lineIndex: number, label: string): [number, number, number] {
  const values = line.split(/\s+/).slice(1, 4).map(Number);
  if (values.length !== 3 || !values.every(Number.isFinite)) {
    throw new Error(`${label}: 第 ${lineIndex + 1} 行需要 3 个数字`);
  }
  return [values[0], values[1], values[2]];
}

function validateDomain(min: [number, number, number], max: [number, number, number], sourceName: string) {
  for (let index = 0; index < 3; index += 1) {
    if (max[index] <= min[index]) {
      throw new Error(`${sourceName}: DOMAIN_MAX 必须大于 DOMAIN_MIN`);
    }
  }
}
