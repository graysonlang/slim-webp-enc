// RGBA → Y'CbCr 4:2:0 (BT.601, studio range) with box-filter chroma
// subsampling, padded to whole macroblocks by edge replication.
// Conversion coefficients match libwebp picture_csp_enc.c (YUV_FIX = 16).

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

function clipUV(v: number): number {
  v = (v + YUV_HALF + (128 << YUV_FIX)) >> YUV_FIX;
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

function rgbToU(r: number, g: number, b: number): number {
  return clipUV(-9719 * r - 19081 * g + 28800 * b);
}

function rgbToV(r: number, g: number, b: number): number {
  return clipUV(28800 * r - 24116 * g - 4684 * b);
}

/**
 * Convert interleaved RGBA to padded YUV420. Alpha is ignored (the alpha
 * plane travels separately in the ALPH chunk).
 */
export function rgbaToYuv420(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
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

  // Chroma: average RGB over each 2x2 block (box filter), then convert.
  for (let cy = 0; cy < mbH * 8; cy++) {
    for (let cx = 0; cx < uvStride; cx++) {
      let r = 0, g = 0, b = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          let sx = cx * 2 + dx;
          let sy = cy * 2 + dy;
          if (sx >= width) sx = width - 1;
          if (sy >= height) sy = height - 1;
          const i = (sy * width + sx) * 4;
          r += rgba[i];
          g += rgba[i + 1];
          b += rgba[i + 2];
        }
      }
      // scale sums by 1/4 inside the fixed-point conversion (round via +2)
      r = (r + 2) >> 2;
      g = (g + 2) >> 2;
      b = (b + 2) >> 2;
      uPlane[cy * uvStride + cx] = rgbToU(r, g, b);
      vPlane[cy * uvStride + cx] = rgbToV(r, g, b);
    }
  }

  return { width, height, mbW, mbH, yStride, uvStride, y: yPlane, u: uPlane, v: vPlane };
}
