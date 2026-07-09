interface RenderRequest {
  type: 'render';
  id: string;
  fileName: string;
  format: 'jpeg' | 'tiff' | 'png';
  sourceBuffer: ArrayBuffer;
  mimeType: string;
  jpegQuality?: number;
  colorSpace?: 'SRGB' | 'ADOBE_RGB';
}

interface RenderResponse {
  type: 'success' | 'error';
  id: string;
  fileName?: string;
  dataUrl?: string;
  error?: string;
}

self.onmessage = async (event: MessageEvent<RenderRequest>) => {
  const request = event.data;
  if (request.type !== 'render') return;

  try {
    const blob = new Blob([request.sourceBuffer], { type: request.mimeType });
    const bitmap = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d');

    if (!ctx) {
      bitmap.close();
      throw new Error('Canvas is unavailable for rendered export.');
    }

    ctx.drawImage(bitmap, 0, 0);
    bitmap.close();

    const targetColorSpace = request.colorSpace ?? 'SRGB';
    if (targetColorSpace === 'ADOBE_RGB') {
      applyColorSpaceEncoding(canvas, ctx);
    }

    const dataUrl = request.format === 'tiff'
      ? encodeCanvasAsTiff(canvas, targetColorSpace)
      : request.format === 'png'
        ? await encodeCanvasAsPng(canvas, targetColorSpace)
        : await encodeCanvasAsJpeg(canvas, request.jpegQuality, targetColorSpace);

    const response: RenderResponse = {
      type: 'success',
      id: request.id,
      fileName: request.fileName,
      dataUrl,
    };
    self.postMessage(response);
  } catch (error) {
    const response: RenderResponse = {
      type: 'error',
      id: request.id,
      error: error instanceof Error ? error.message : 'Rendered export failed.',
    };
    self.postMessage(response);
  }
};

async function encodeCanvasAsJpeg(canvas: OffscreenCanvas, quality = 100, colorSpace: 'SRGB' | 'ADOBE_RGB' = 'SRGB') {
  const normalizedQuality = Math.min(1, Math.max(0.01, quality / 100));
  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: normalizedQuality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const output = colorSpace === 'ADOBE_RGB'
    ? injectJpegApp2Icc(bytes, getAdobeRgbIccProfile())
    : bytes;
  return `data:image/jpeg;base64,${bytesToBase64(output)}`;
}

async function encodeCanvasAsPng(canvas: OffscreenCanvas, colorSpace: 'SRGB' | 'ADOBE_RGB' = 'SRGB') {
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const output = colorSpace === 'ADOBE_RGB'
    ? injectPngIcc(bytes, getAdobeRgbIccProfile(), 'Adobe RGB (1998)')
    : bytes;
  return `data:image/png;base64,${bytesToBase64(output)}`;
}

function encodeCanvasAsTiff(canvas: OffscreenCanvas, colorSpace: 'SRGB' | 'ADOBE_RGB' = 'SRGB'): string {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas is unavailable for TIFF export.');
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const bytes = encodeUncompressedTiff(imageData, colorSpace);
  return `data:image/tiff;base64,${bytesToBase64(bytes)}`;
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunkSize = 0x8000;
  let binary = '';

  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }

  return btoa(binary);
}

function encodeUncompressedTiff(imageData: ImageData, colorSpace: 'SRGB' | 'ADOBE_RGB'): Uint8Array {
  const { width, height, data } = imageData;
  const pixelBytes = width * height * 3;
  const ifdOffset = 8;
  const iccProfile = colorSpace === 'ADOBE_RGB' ? getAdobeRgbIccProfile() : null;
  const entries = iccProfile ? 11 : 10;
  const ifdSize = 2 + entries * 12 + 4;
  const bitsOffset = ifdOffset + ifdSize;
  const iccOffset = bitsOffset + 6;
  const pixelOffset = iccProfile ? iccOffset + iccProfile.length : iccOffset;
  const totalSize = pixelOffset + pixelBytes;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  out[0] = 0x49;
  out[1] = 0x49;
  view.setUint16(2, 42, true);
  view.setUint32(4, ifdOffset, true);
  view.setUint16(ifdOffset, entries, true);

  let cursor = ifdOffset + 2;
  const addEntry = (tag: number, type: number, count: number, value: number) => {
    view.setUint16(cursor, tag, true);
    view.setUint16(cursor + 2, type, true);
    view.setUint32(cursor + 4, count, true);
    if (type === 3 && count === 1) {
      view.setUint16(cursor + 8, value, true);
      view.setUint16(cursor + 10, 0, true);
    } else {
      view.setUint32(cursor + 8, value, true);
    }
    cursor += 12;
  };

  addEntry(256, 4, 1, width);
  addEntry(257, 4, 1, height);
  addEntry(258, 3, 3, bitsOffset);
  addEntry(259, 3, 1, 1);
  addEntry(262, 3, 1, 2);
  addEntry(273, 4, 1, pixelOffset);
  addEntry(277, 3, 1, 3);
  addEntry(278, 4, 1, height);
  addEntry(279, 4, 1, pixelBytes);
  addEntry(284, 3, 1, 1);
  if (iccProfile) {
    addEntry(34675, 7, iccProfile.length, iccOffset);
  }

  view.setUint32(cursor, 0, true);
  view.setUint16(bitsOffset, 8, true);
  view.setUint16(bitsOffset + 2, 8, true);
  view.setUint16(bitsOffset + 4, 8, true);
  if (iccProfile) {
    out.set(iccProfile, iccOffset);
  }

  let target = pixelOffset;
  for (let source = 0; source < data.length; source += 4) {
    out[target++] = data[source];
    out[target++] = data[source + 1];
    out[target++] = data[source + 2];
  }

  return out;
}

function applyColorSpaceEncoding(canvas: OffscreenCanvas, ctx: OffscreenCanvasRenderingContext2D) {
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const pixels = imageData.data;
  for (let index = 0; index < pixels.length; index += 4) {
    const [red, green, blue] = convertSrgbBytesToAdobeRgb(
      pixels[index],
      pixels[index + 1],
      pixels[index + 2],
    );
    pixels[index] = red;
    pixels[index + 1] = green;
    pixels[index + 2] = blue;
  }
  ctx.putImageData(imageData, 0, 0);
}

function convertSrgbBytesToAdobeRgb(
  redByte: number,
  greenByte: number,
  blueByte: number,
) {
  const srgbLinear = [
    srgbByteToLinear(redByte),
    srgbByteToLinear(greenByte),
    srgbByteToLinear(blueByte),
  ];
  const xyz = multiplyMatrix3x3(SRGB_TO_XYZ_D65, srgbLinear);
  const targetLinear = multiplyMatrix3x3(XYZ_D65_TO_ADOBE_RGB, xyz);
  return [
    encodeAdobeRgb(targetLinear[0]),
    encodeAdobeRgb(targetLinear[1]),
    encodeAdobeRgb(targetLinear[2]),
  ];
}

function injectJpegApp2Icc(jpegBytes: Uint8Array, iccProfile: Uint8Array) {
  if (jpegBytes.length < 4 || jpegBytes[0] !== 0xff || jpegBytes[1] !== 0xd8) {
    return jpegBytes;
  }

  const identifier = new TextEncoder().encode('ICC_PROFILE\0');
  const payloadLength = identifier.length + 2 + iccProfile.length;
  const segmentLength = payloadLength + 2;
  if (segmentLength > 0xffff) {
    return jpegBytes;
  }

  const app2 = new Uint8Array(2 + 2 + payloadLength);
  app2[0] = 0xff;
  app2[1] = 0xe2;
  app2[2] = (segmentLength >> 8) & 0xff;
  app2[3] = segmentLength & 0xff;
  app2.set(identifier, 4);
  app2[4 + identifier.length] = 1;
  app2[5 + identifier.length] = 1;
  app2.set(iccProfile, 6 + identifier.length);

  const output = new Uint8Array(jpegBytes.length + app2.length);
  output.set(jpegBytes.subarray(0, 2), 0);
  output.set(app2, 2);
  output.set(jpegBytes.subarray(2), 2 + app2.length);
  return output;
}

function injectPngIcc(pngBytes: Uint8Array, iccProfile: Uint8Array, profileName: string) {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (pngBytes.length < 33 || !signature.every((value, index) => pngBytes[index] === value)) {
    return pngBytes;
  }

  const ihdrChunkLength = readUint32be(pngBytes, 8);
  const afterIhdr = 8 + 12 + ihdrChunkLength;
  if (afterIhdr > pngBytes.length) {
    return pngBytes;
  }

  const nameBytes = new TextEncoder().encode(profileName);
  const compressedProfile = zlibStoreBlocks(iccProfile);
  const payload = new Uint8Array(nameBytes.length + 2 + compressedProfile.length);
  payload.set(nameBytes, 0);
  payload[nameBytes.length] = 0;
  payload[nameBytes.length + 1] = 0;
  payload.set(compressedProfile, nameBytes.length + 2);
  const iccpChunk = buildPngChunk('iCCP', payload);

  const output = new Uint8Array(pngBytes.length + iccpChunk.length);
  output.set(pngBytes.subarray(0, afterIhdr), 0);
  output.set(iccpChunk, afterIhdr);
  output.set(pngBytes.subarray(afterIhdr), afterIhdr + iccpChunk.length);
  return output;
}

function buildPngChunk(type: string, data: Uint8Array) {
  const typeBytes = new TextEncoder().encode(type);
  const chunk = new Uint8Array(12 + data.length);
  writeUint32be(chunk, 0, data.length);
  chunk.set(typeBytes, 4);
  chunk.set(data, 8);
  const crcPayload = new Uint8Array(typeBytes.length + data.length);
  crcPayload.set(typeBytes, 0);
  crcPayload.set(data, typeBytes.length);
  writeUint32be(chunk, 8 + data.length, crc32(crcPayload));
  return chunk;
}

function zlibStoreBlocks(data: Uint8Array) {
  const blockCount = Math.ceil(data.length / 0xffff) || 1;
  const output = new Uint8Array(2 + data.length + blockCount * 5 + 4);
  let offset = 0;
  output[offset++] = 0x78;
  output[offset++] = 0x01;

  let source = 0;
  while (source < data.length || (data.length === 0 && source === 0)) {
    const remaining = data.length - source;
    const blockLength = Math.min(0xffff, Math.max(0, remaining));
    const finalBlock = source + blockLength >= data.length;
    output[offset++] = finalBlock ? 0x01 : 0x00;
    output[offset++] = blockLength & 0xff;
    output[offset++] = (blockLength >> 8) & 0xff;
    const nlen = (~blockLength) & 0xffff;
    output[offset++] = nlen & 0xff;
    output[offset++] = (nlen >> 8) & 0xff;
    output.set(data.subarray(source, source + blockLength), offset);
    offset += blockLength;
    source += blockLength;
    if (data.length === 0) break;
  }

  writeUint32be(output, offset, adler32(data));
  return output.subarray(0, offset + 4);
}

function readUint32be(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] << 24)
    | (bytes[offset + 1] << 16)
    | (bytes[offset + 2] << 8)
    | bytes[offset + 3]
  ) >>> 0;
}

function writeUint32be(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = (value >>> 24) & 0xff;
  bytes[offset + 1] = (value >>> 16) & 0xff;
  bytes[offset + 2] = (value >>> 8) & 0xff;
  bytes[offset + 3] = value & 0xff;
}

let crcTable: Uint32Array | null = null;

function crc32(bytes: Uint8Array) {
  const table = crcTable ?? (crcTable = buildCrcTable());
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = table[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1);
    }
    table[index] = value >>> 0;
  }
  return table;
}

function adler32(bytes: Uint8Array) {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const SRGB_TO_XYZ_D65 = [
  [0.4124564, 0.3575761, 0.1804375],
  [0.2126729, 0.7151522, 0.072175],
  [0.0193339, 0.119192, 0.9503041],
];

const XYZ_D65_TO_ADOBE_RGB = [
  [2.041369, -0.5649464, -0.3446944],
  [-0.969266, 1.8760108, 0.041556],
  [0.0134474, -0.1183897, 1.0154096],
];

const D65_WHITEPOINT = [0.95047, 1, 1.08883];
const D50_WHITEPOINT = [0.9642, 1, 0.82491];
const BRADFORD = [
  [0.8951, 0.2664, -0.1614],
  [-0.7502, 1.7135, 0.0367],
  [0.0389, -0.0685, 1.0296],
];
const BRADFORD_INVERSE = [
  [0.9869929, -0.1470543, 0.1599627],
  [0.4323053, 0.5183603, 0.0492912],
  [-0.0085287, 0.0400428, 0.9684867],
];

let adobeRgbIccCache: Uint8Array | null = null;

function getAdobeRgbIccProfile() {
  if (!adobeRgbIccCache) {
    adobeRgbIccCache = buildRgbIccProfile({
      description: 'Adobe RGB (1998)',
      copyright: 'Copyright Adobe Systems Incorporated',
      gamma: 563 / 256,
      primaries: {
        r: [0.64, 0.33],
        g: [0.21, 0.71],
        b: [0.15, 0.06],
      },
      whitepoint: D65_WHITEPOINT,
    });
  }
  return adobeRgbIccCache;
}

function srgbByteToLinear(value: number) {
  const normalized = value / 255;
  return normalized <= 0.04045
    ? normalized / 12.92
    : ((normalized + 0.055) / 1.055) ** 2.4;
}

function encodeAdobeRgb(value: number) {
  const clamped = Math.max(0, Math.min(1, value));
  return Math.round(clamped ** (1 / (563 / 256)) * 255);
}

function multiplyMatrix3x3(matrix: number[][], vector: number[]) {
  return matrix.map(row => row[0] * vector[0] + row[1] * vector[1] + row[2] * vector[2]);
}

function buildRgbIccProfile({
  description,
  copyright,
  gamma,
  primaries,
  whitepoint,
}: {
  description: string;
  copyright: string;
  gamma: number;
  primaries: { r: [number, number]; g: [number, number]; b: [number, number] };
  whitepoint: number[];
}) {
  const matrixD65 = computeRgbToXyzMatrix(primaries, whitepoint);
  const matrixD50 = adaptMatrixToD50(matrixD65);
  const redXyz = [matrixD50[0][0], matrixD50[1][0], matrixD50[2][0]];
  const greenXyz = [matrixD50[0][1], matrixD50[1][1], matrixD50[2][1]];
  const blueXyz = [matrixD50[0][2], matrixD50[1][2], matrixD50[2][2]];

  const tags = [
    { signature: 'desc', bytes: buildDescTag(description) },
    { signature: 'cprt', bytes: buildTextTag(copyright) },
    { signature: 'wtpt', bytes: buildXyzTag(D50_WHITEPOINT) },
    { signature: 'bkpt', bytes: buildXyzTag([0, 0, 0]) },
    { signature: 'rXYZ', bytes: buildXyzTag(redXyz) },
    { signature: 'gXYZ', bytes: buildXyzTag(greenXyz) },
    { signature: 'bXYZ', bytes: buildXyzTag(blueXyz) },
    { signature: 'rTRC', bytes: buildCurveTag(gamma) },
    { signature: 'gTRC', bytes: buildCurveTag(gamma) },
    { signature: 'bTRC', bytes: buildCurveTag(gamma) },
  ];

  const headerSize = 128;
  const tagTableSize = 4 + tags.length * 12;
  let offset = headerSize + tagTableSize;
  const alignedTags = tags.map(tag => {
    const start = align4(offset);
    offset = start + align4(tag.bytes.length);
    return { ...tag, offset: start, size: tag.bytes.length };
  });
  const totalSize = offset;
  const buffer = new ArrayBuffer(totalSize);
  const view = new DataView(buffer);
  const out = new Uint8Array(buffer);

  writeIccHeader(view, totalSize);
  view.setUint32(128, tags.length, false);
  alignedTags.forEach((tag, index) => {
    const entryOffset = 132 + index * 12;
    writeSignature(out, entryOffset, tag.signature);
    view.setUint32(entryOffset + 4, tag.offset, false);
    view.setUint32(entryOffset + 8, tag.size, false);
    out.set(tag.bytes, tag.offset);
  });

  return out;
}

function writeIccHeader(view: DataView, totalSize: number) {
  const out = new Uint8Array(view.buffer);
  view.setUint32(0, totalSize, false);
  writeSignature(out, 4, 'LkCD');
  view.setUint32(8, 0x02100000, false);
  writeSignature(out, 12, 'mntr');
  writeSignature(out, 16, 'RGB ');
  writeSignature(out, 20, 'XYZ ');
  const now = new Date();
  view.setUint16(24, now.getUTCFullYear(), false);
  view.setUint16(26, now.getUTCMonth() + 1, false);
  view.setUint16(28, now.getUTCDate(), false);
  view.setUint16(30, now.getUTCHours(), false);
  view.setUint16(32, now.getUTCMinutes(), false);
  view.setUint16(34, now.getUTCSeconds(), false);
  writeSignature(out, 36, 'acsp');
  writeSignature(out, 40, 'MSFT');
  view.setUint32(44, 0, false);
  view.setUint32(48, 0, false);
  view.setUint32(52, 0, false);
  view.setUint32(56, 0, false);
  view.setUint32(60, 0, false);
  view.setUint32(64, 0, false);
  view.setUint32(68, 0, false);
  writeS15Fixed16(view, 68, D50_WHITEPOINT[0]);
  writeS15Fixed16(view, 72, D50_WHITEPOINT[1]);
  writeS15Fixed16(view, 76, D50_WHITEPOINT[2]);
  writeSignature(out, 80, 'LCUL');
}

function buildDescTag(text: string) {
  const ascii = new TextEncoder().encode(`${text}\0`);
  const bytes = new Uint8Array(12 + ascii.length);
  writeSignature(bytes, 0, 'desc');
  const view = new DataView(bytes.buffer);
  view.setUint32(8, ascii.length, false);
  bytes.set(ascii, 12);
  return bytes;
}

function buildTextTag(text: string) {
  const ascii = new TextEncoder().encode(text);
  const bytes = new Uint8Array(8 + ascii.length);
  writeSignature(bytes, 0, 'text');
  bytes.set(ascii, 8);
  return bytes;
}

function buildXyzTag([x, y, z]: number[]) {
  const bytes = new Uint8Array(20);
  writeSignature(bytes, 0, 'XYZ ');
  const view = new DataView(bytes.buffer);
  writeS15Fixed16(view, 8, x);
  writeS15Fixed16(view, 12, y);
  writeS15Fixed16(view, 16, z);
  return bytes;
}

function buildCurveTag(gamma: number) {
  const bytes = new Uint8Array(14);
  writeSignature(bytes, 0, 'curv');
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 1, false);
  view.setUint16(12, Math.round(gamma * 256), false);
  return bytes;
}

function computeRgbToXyzMatrix(
  primaries: { r: [number, number]; g: [number, number]; b: [number, number] },
  whitepoint: number[],
) {
  const xr = primaries.r[0];
  const yr = primaries.r[1];
  const xg = primaries.g[0];
  const yg = primaries.g[1];
  const xb = primaries.b[0];
  const yb = primaries.b[1];

  const Xr = xr / yr;
  const Yr = 1;
  const Zr = (1 - xr - yr) / yr;
  const Xg = xg / yg;
  const Yg = 1;
  const Zg = (1 - xg - yg) / yg;
  const Xb = xb / yb;
  const Yb = 1;
  const Zb = (1 - xb - yb) / yb;

  const primaryMatrix = [
    [Xr, Xg, Xb],
    [Yr, Yg, Yb],
    [Zr, Zg, Zb],
  ];
  const scaling = multiplyMatrix3x3(
    invert3x3(primaryMatrix),
    whitepoint,
  );

  return [
    [primaryMatrix[0][0] * scaling[0], primaryMatrix[0][1] * scaling[1], primaryMatrix[0][2] * scaling[2]],
    [primaryMatrix[1][0] * scaling[0], primaryMatrix[1][1] * scaling[1], primaryMatrix[1][2] * scaling[2]],
    [primaryMatrix[2][0] * scaling[0], primaryMatrix[2][1] * scaling[1], primaryMatrix[2][2] * scaling[2]],
  ];
}

function adaptMatrixToD50(matrixD65: number[][]) {
  const sourceCone = multiplyMatrix3x3(BRADFORD, D65_WHITEPOINT);
  const targetCone = multiplyMatrix3x3(BRADFORD, D50_WHITEPOINT);
  const adapt = [
    [targetCone[0] / sourceCone[0], 0, 0],
    [0, targetCone[1] / sourceCone[1], 0],
    [0, 0, targetCone[2] / sourceCone[2]],
  ];
  const left = multiplyMatrices3x3(BRADFORD_INVERSE, adapt);
  const adaptationMatrix = multiplyMatrices3x3(left, BRADFORD);
  return multiplyMatrices3x3(adaptationMatrix, matrixD65);
}

function multiplyMatrices3x3(a: number[][], b: number[][]) {
  return Array.from({ length: 3 }, (_, row) =>
    Array.from({ length: 3 }, (_, col) =>
      a[row][0] * b[0][col] + a[row][1] * b[1][col] + a[row][2] * b[2][col],
    ),
  );
}

function invert3x3(matrix: number[][]) {
  const [
    [a, b, c],
    [d, e, f],
    [g, h, i],
  ] = matrix;
  const det = a * (e * i - f * h) - b * (d * i - f * g) + c * (d * h - e * g);
  if (Math.abs(det) < 1e-12) {
    throw new Error('Color transform matrix is singular.');
  }
  const invDet = 1 / det;
  return [
    [(e * i - f * h) * invDet, (c * h - b * i) * invDet, (b * f - c * e) * invDet],
    [(f * g - d * i) * invDet, (a * i - c * g) * invDet, (c * d - a * f) * invDet],
    [(d * h - e * g) * invDet, (b * g - a * h) * invDet, (a * e - b * d) * invDet],
  ];
}

function writeSignature(target: Uint8Array, offset: number, signature: string) {
  target.set(new TextEncoder().encode(signature), offset);
}

function writeS15Fixed16(view: DataView, offset: number, value: number) {
  view.setInt32(offset, Math.round(value * 65536), false);
}

function align4(value: number) {
  return (value + 3) & ~3;
}

export {};
