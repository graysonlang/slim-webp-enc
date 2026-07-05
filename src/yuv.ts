// RGBA → Y'CbCr 4:2:0 (BT.601, studio range), padded to whole macroblocks by
// edge replication. Follows libwebp's import pipeline (picture_csp_enc.c,
// dsp/yuv.c, YUV_FIX = 16) so lossy output stays at parity with what browsers'
// native encoders produce:
//  - luma is converted per pixel (identical fixed-point coefficients);
//  - chroma is averaged over 2x2 blocks in gamma-compressed linear space
//    (USE_GAMMA_COMPRESSION, gamma 0.8), then converted at 4x precision;
//  - 2x2 blocks with mixed transparency average only the visible pixels,
//    weighted by alpha (WebPAccumulateRGBA) — without this, colors bleeding
//    from under the alpha mask wash out edge chroma on small images;
//  - smoothTransparentAreas ports WebPCleanupTransparentArea's lossy path:
//    transparent luma becomes the 8x8-block-local visible average, and fully
//    transparent 8x8 blocks are flattened, so the invisible region costs few
//    bits instead of spraying quantization error into visible pixels.

export interface YuvImage {
  width: number; // original pixel dimensions
  height: number;
  mbW: number; // macroblock counts
  mbH: number;
  yStride: number; // = mbW * 16
  uvStride: number; // = mbW * 8
  y: Uint8Array;
  u: Uint8Array;
  v: Uint8Array;
}

const YUV_FIX = 16;
const YUV_HALF = 1 << (YUV_FIX - 1);

function rgbToY(r: number, g: number, b: number): number {
  return (16839 * r + 33059 * g + 6420 * b + YUV_HALF + (16 << YUV_FIX)) >> YUV_FIX;
}

// ---------------------------------------------------------------------------
// Gamma-compressed averaging (libwebp dsp/yuv.c, USE_GAMMA_COMPRESSION).
// Averaging chroma in a near-linear space compensates the resolution loss of
// 4:2:0 subsampling at saturated edges.

const GAMMA_FIX = 12; // fixed-point precision for linear values
const GAMMA_TAB_FIX = 7; // fractional bits of the interpolation table
const GAMMA_TAB_SCALE = 1 << GAMMA_TAB_FIX;
const GAMMA_TAB_ROUNDER = GAMMA_TAB_SCALE >> 1;
const GAMMA_TAB_SIZE = 1 << (GAMMA_FIX - GAMMA_TAB_FIX);
const GAMMA_SCALE = (1 << GAMMA_FIX) - 1;

/** gamma domain (8-bit) → linear (GAMMA_FIX fixed point), v^(1/0.8) scaled. */
const gammaToLinearTab = new Uint16Array(256);
/** linear table index → gamma domain (8-bit), for interpolation. */
const linearToGammaTab = new Int32Array(GAMMA_TAB_SIZE + 1);
{
  for (let v = 0; v <= 255; v++) {
    gammaToLinearTab[v] = Math.floor(Math.pow(v / 255, 0.8) * GAMMA_SCALE + 0.5);
  }
  const scale = GAMMA_TAB_SCALE / GAMMA_SCALE;
  for (let v = 0; v <= GAMMA_TAB_SIZE; v++) {
    linearToGammaTab[v] = Math.floor(255 * Math.pow(scale * v, 1 / 0.8) + 0.5);
  }
}

/** Sum of four linear values → gamma-domain value at 4x scale (LinearToGamma). */
function linearToGamma4(base: number): number {
  const tabPos = base >> (GAMMA_TAB_FIX + 2); // integer part
  const x = base & ((GAMMA_TAB_SCALE << 2) - 1); // fractional part
  const y = linearToGammaTab[tabPos + 1] * x +
    linearToGammaTab[tabPos] * ((GAMMA_TAB_SCALE << 2) - x);
  return (y + GAMMA_TAB_ROUNDER) >> GAMMA_TAB_FIX;
}

/** U/V conversion for 4x-scaled RGB sums (VP8ClipUV with YUV_FIX+2 rounding). */
function clipUV4(uv: number): number {
  uv = (uv + (YUV_HALF << 2) + (128 << (YUV_FIX + 2))) >> (YUV_FIX + 2);
  return uv < 0 ? 0 : uv > 255 ? 255 : uv;
}

/**
 * Convert interleaved RGBA to padded YUV420. When `alpha` (a width*height
 * plane) is provided, 2x2 chroma blocks with mixed transparency are averaged
 * with per-pixel alpha weights so fully transparent pixels contribute nothing.
 */
export function rgbaToYuv420(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
  alpha?: Uint8Array,
): YuvImage {
  const mbW = (width + 15) >> 4;
  const mbH = (height + 15) >> 4;
  const yStride = mbW * 16;
  const uvStride = mbW * 8;
  const yPlane = new Uint8Array(yStride * mbH * 16);
  const uPlane = new Uint8Array(uvStride * mbH * 8);
  const vPlane = new Uint8Array(uvStride * mbH * 8);

  // Luma
  for (let yy = 0; yy < mbH * 16; yy++) {
    const sy = yy < height ? yy : height - 1;
    for (let xx = 0; xx < yStride; xx++) {
      const sx = xx < width ? xx : width - 1;
      const i = (sy * width + sx) * 4;
      yPlane[yy * yStride + xx] = rgbToY(rgba[i], rgba[i + 1], rgba[i + 2]);
    }
  }

  // Chroma: 2x2 accumulation in gamma-linear space, converted at 4x scale.
  const idx = [0, 0, 0, 0];
  for (let cy = 0; cy < mbH * 8; cy++) {
    for (let cx = 0; cx < uvStride; cx++) {
      for (let k = 0; k < 4; k++) {
        let sx = cx * 2 + (k & 1);
        let sy = cy * 2 + (k >> 1);
        if (sx >= width) sx = width - 1;
        if (sy >= height) sy = height - 1;
        idx[k] = sy * width + sx;
      }
      let aSum = 4 * 255;
      if (alpha) {
        aSum = alpha[idx[0]] + alpha[idx[1]] + alpha[idx[2]] + alpha[idx[3]];
      }
      let r4: number, g4: number, b4: number;
      if (aSum === 0 || aSum === 4 * 255) {
        r4 = linearToGamma4(
          gammaToLinearTab[rgba[idx[0] * 4]] + gammaToLinearTab[rgba[idx[1] * 4]] +
            gammaToLinearTab[rgba[idx[2] * 4]] + gammaToLinearTab[rgba[idx[3] * 4]],
        );
        g4 = linearToGamma4(
          gammaToLinearTab[rgba[idx[0] * 4 + 1]] + gammaToLinearTab[rgba[idx[1] * 4 + 1]] +
            gammaToLinearTab[rgba[idx[2] * 4 + 1]] + gammaToLinearTab[rgba[idx[3] * 4 + 1]],
        );
        b4 = linearToGamma4(
          gammaToLinearTab[rgba[idx[0] * 4 + 2]] + gammaToLinearTab[rgba[idx[1] * 4 + 2]] +
            gammaToLinearTab[rgba[idx[2] * 4 + 2]] + gammaToLinearTab[rgba[idx[3] * 4 + 2]],
        );
      } else {
        // Mixed-alpha block: alpha-weighted linear average, ×4 to keep the
        // scale of the opaque path (WebPAccumulateRGBA / DIVIDE_BY_ALPHA).
        const a = alpha!;
        const weighted = (c: number) => {
          const sum = a[idx[0]] * gammaToLinearTab[rgba[idx[0] * 4 + c]] +
            a[idx[1]] * gammaToLinearTab[rgba[idx[1] * 4 + c]] +
            a[idx[2]] * gammaToLinearTab[rgba[idx[2] * 4 + c]] +
            a[idx[3]] * gammaToLinearTab[rgba[idx[3] * 4 + c]];
          return linearToGamma4(((4 * sum) / aSum) | 0);
        };
        r4 = weighted(0);
        g4 = weighted(1);
        b4 = weighted(2);
      }
      uPlane[cy * uvStride + cx] = clipUV4(-9719 * r4 - 19081 * g4 + 28800 * b4);
      vPlane[cy * uvStride + cx] = clipUV4(28800 * r4 - 24116 * g4 - 4684 * b4);
    }
  }

  return { width, height, mbW, mbH, yStride, uvStride, y: yPlane, u: uPlane, v: vPlane };
}

// ---------------------------------------------------------------------------
// Transparent-area cleanup (libwebp WebPCleanupTransparentArea, lossy path).

const SMOOTH_SIZE = 8;

/**
 * Set transparent pixels' luma in one block to the block's visible average.
 * Returns true when the whole block is transparent (candidate for flatten).
 */
function smoothenBlock(
  yuv: YuvImage,
  alpha: Uint8Array,
  bx: number,
  by: number,
  bw: number,
  bh: number,
): boolean {
  const { y: yPlane, yStride, width } = yuv;
  let sum = 0;
  let count = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (alpha[(by + y) * width + bx + x] !== 0) {
        count++;
        sum += yPlane[(by + y) * yStride + bx + x];
      }
    }
  }
  if (count > 0 && count < bw * bh) {
    const avg = (sum / count) | 0;
    for (let y = 0; y < bh; y++) {
      for (let x = 0; x < bw; x++) {
        if (alpha[(by + y) * width + bx + x] === 0) {
          yPlane[(by + y) * yStride + bx + x] = avg;
        }
      }
    }
  }
  return count === 0;
}

function flatten(plane: Uint8Array, stride: number, ox: number, oy: number, v: number, size: number): void {
  for (let y = 0; y < size; y++) {
    plane.fill(v, (oy + y) * stride + ox, (oy + y) * stride + ox + size);
  }
}

/**
 * Smooth luma under transparent pixels (8x8-block-local visible average) and
 * flatten fully transparent 8x8 blocks, then refresh the replicated padding.
 * Call after rgbaToYuv420 whenever the image has transparency.
 */
export function smoothTransparentAreas(yuv: YuvImage, alpha: Uint8Array): void {
  const { width, height, yStride, uvStride } = yuv;
  let y = 0;
  for (; y + SMOOTH_SIZE <= height; y += SMOOTH_SIZE) {
    let needReset = true;
    let vY = 0, vU = 0, vV = 0;
    let x = 0;
    for (; x + SMOOTH_SIZE <= width; x += SMOOTH_SIZE) {
      if (smoothenBlock(yuv, alpha, x, y, SMOOTH_SIZE, SMOOTH_SIZE)) {
        if (needReset) {
          vY = yuv.y[y * yStride + x];
          vU = yuv.u[(y >> 1) * uvStride + (x >> 1)];
          vV = yuv.v[(y >> 1) * uvStride + (x >> 1)];
          needReset = false;
        }
        flatten(yuv.y, yStride, x, y, vY, SMOOTH_SIZE);
        flatten(yuv.u, uvStride, x >> 1, y >> 1, vU, SMOOTH_SIZE / 2);
        flatten(yuv.v, uvStride, x >> 1, y >> 1, vV, SMOOTH_SIZE / 2);
      } else {
        needReset = true;
      }
    }
    if (x < width) smoothenBlock(yuv, alpha, x, y, width - x, SMOOTH_SIZE);
  }
  if (y < height) {
    for (let x = 0; x < width; x += SMOOTH_SIZE) {
      smoothenBlock(yuv, alpha, x, y, Math.min(SMOOTH_SIZE, width - x), height - y);
    }
  }

  // Padding replicates source edges; smoothing may have rewritten those
  // edges, so re-replicate to keep the padded area residual-free.
  repadPlane(yuv.y, yStride, width, height, yuv.mbH * 16);
  repadPlane(yuv.u, uvStride, (width + 1) >> 1, (height + 1) >> 1, yuv.mbH * 8);
  repadPlane(yuv.v, uvStride, (width + 1) >> 1, (height + 1) >> 1, yuv.mbH * 8);
}

function repadPlane(plane: Uint8Array, stride: number, w: number, h: number, paddedH: number): void {
  if (w < stride) {
    for (let y = 0; y < h; y++) {
      plane.fill(plane[y * stride + w - 1], y * stride + w, (y + 1) * stride);
    }
  }
  for (let y = h; y < paddedH; y++) {
    plane.copyWithin(y * stride, (h - 1) * stride, h * stride);
  }
}
