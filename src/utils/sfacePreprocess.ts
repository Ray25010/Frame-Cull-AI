export function rgbaToSfaceChw(rgba: Uint8ClampedArray, pixelCount: number) {
  const data = new Float32Array(3 * pixelCount);
  for (let pixel = 0, source = 0; pixel < pixelCount; pixel += 1, source += 4) {
    data[pixel] = rgba[source];
    data[pixelCount + pixel] = rgba[source + 1];
    data[pixelCount * 2 + pixel] = rgba[source + 2];
  }
  return data;
}
