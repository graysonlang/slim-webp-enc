// Image quality metrics. RGBA inputs are composited over a checkerboard first,
// so alpha errors show up in the RGB metrics instead of being ignored.

export interface Metrics {
  psnr: number;
  ssim: number;
}

/** Composite RGBA over an 8px checkerboard (white / light gray). Returns RGB. */
export function compositeCheckerboard(
  rgba: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const rgb = new Uint8Array(width * height * 3);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bg = ((x >> 3) + (y >> 3)) % 2 === 0 ? 255 : 190;
      const i = (y * width + x) * 4;
      const o = (y * width + x) * 3;
      const a = rgba[i + 3] / 255;
      rgb[o] = Math.round(rgba[i] * a + bg * (1 - a));
      rgb[o + 1] = Math.round(rgba[i + 1] * a + bg * (1 - a));
      rgb[o + 2] = Math.round(rgba[i + 2] * a + bg * (1 - a));
    }
  }
  return rgb;
}

/** PSNR in dB across all RGB samples. Infinity for identical images. */
export function psnrRGB(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error("size mismatch");
  let se = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    se += d * d;
  }
  if (se === 0) return Infinity;
  const mse = se / a.length;
  return 10 * Math.log10((255 * 255) / mse);
}

function toLuma(rgb: Uint8Array): Float64Array {
  const n = rgb.length / 3;
  const y = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    y[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
  }
  return y;
}

/**
 * Mean SSIM on luma, uniform 8x8 windows with stride 4.
 * Standard constants C1=(0.01*255)^2, C2=(0.03*255)^2.
 */
export function ssimLuma(
  rgbA: Uint8Array,
  rgbB: Uint8Array,
  width: number,
  height: number,
): number {
  const a = toLuma(rgbA);
  const b = toLuma(rgbB);
  const WIN = 8;
  const STRIDE = 4;
  const C1 = (0.01 * 255) ** 2;
  const C2 = (0.03 * 255) ** 2;
  let total = 0;
  let count = 0;
  const yMax = Math.max(1, height - WIN + 1);
  const xMax = Math.max(1, width - WIN + 1);
  for (let wy = 0; wy < yMax; wy += STRIDE) {
    for (let wx = 0; wx < xMax; wx += STRIDE) {
      const wH = Math.min(WIN, height - wy);
      const wW = Math.min(WIN, width - wx);
      let sumA = 0, sumB = 0, sumAA = 0, sumBB = 0, sumAB = 0;
      for (let y = 0; y < wH; y++) {
        for (let x = 0; x < wW; x++) {
          const i = (wy + y) * width + (wx + x);
          const va = a[i];
          const vb = b[i];
          sumA += va;
          sumB += vb;
          sumAA += va * va;
          sumBB += vb * vb;
          sumAB += va * vb;
        }
      }
      const n = wH * wW;
      const muA = sumA / n;
      const muB = sumB / n;
      const varA = sumAA / n - muA * muA;
      const varB = sumBB / n - muB * muB;
      const cov = sumAB / n - muA * muB;
      const ssim =
        (((2 * muA * muB + C1) * (2 * cov + C2)) /
          ((muA * muA + muB * muB + C1) * (varA + varB + C2)));
      total += ssim;
      count++;
    }
  }
  return count > 0 ? total / count : 1;
}

export function compareRGBA(
  src: Uint8Array,
  dec: Uint8Array,
  width: number,
  height: number,
): Metrics {
  const a = compositeCheckerboard(src, width, height);
  const b = compositeCheckerboard(dec, width, height);
  return {
    psnr: psnrRGB(a, b),
    ssim: ssimLuma(a, b, width, height),
  };
}

/**
 * Alpha-weighted per-channel PSNR over straight (non-composited) RGB:
 * each pixel's squared error is weighted by its source alpha, so colors
 * hidden under the mask don't count and edge chroma is weighted fairly.
 * Same metric as the parity probe.
 */
export function psnrPerChannelAlphaWeighted(
  src: Uint8Array,
  dec: Uint8Array,
): { r: number; g: number; b: number; rgb: number } {
  const se = [0, 0, 0];
  let wsum = 0;
  for (let i = 0; i < src.length; i += 4) {
    const w = src[i + 3] / 255;
    if (w === 0) continue;
    wsum += w;
    for (let c = 0; c < 3; c++) {
      const d = src[i + c] - dec[i + c];
      se[c] += w * d * d;
    }
  }
  const p = (s: number) =>
    wsum === 0 || s === 0 ? Infinity : 10 * Math.log10((255 * 255 * wsum) / s);
  return { r: p(se[0]), g: p(se[1]), b: p(se[2]), rgb: p((se[0] + se[1] + se[2]) / 3) };
}

/** Max absolute difference between two alpha planes extracted from RGBA. */
export function alphaMaxDiff(src: Uint8Array, dec: Uint8Array): number {
  let max = 0;
  for (let i = 3; i < src.length; i += 4) {
    const d = Math.abs(src[i] - dec[i]);
    if (d > max) max = d;
  }
  return max;
}
