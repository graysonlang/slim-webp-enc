// Public API: pure-TS lossy WebP encoder with alpha support.

export { hasNativeWebPEncoder } from "./detect.ts";

import { alphaPlane, encodeAlpha, type AlphaLevels } from "./alpha.ts";
import { buildWebP, buildWebPLossless } from "./container.ts";
import { rgbaToYuv420, smoothTransparentAreas } from "./yuv.ts";
import { encodeVP8Frame } from "./vp8.ts";
import { encodeVP8L } from "./vp8l.ts";

export interface ImageDataLike {
  data: Uint8Array | Uint8ClampedArray;
  width: number;
  height: number;
}

export interface EncodeOptions {
  /**
   * 0–100, like cwebp. Default 80 when omitted, matching the browsers'
   * native encoder default. Follows the HTML canvas encoding rule (scaled
   * to 0–100): a quality outside the valid range — including NaN and
   * ±Infinity — is treated as if it had not been given and encodes at the
   * default, exactly like the native canvas encoders slim fills in for.
   * Note: unlike `canvas.toBlob('image/webp', 1.0)`, which browsers
   * special-case to fully lossless output, 100 here is still lossy
   * (finest quantization, 4:2:0 chroma) — use `lossless` for pixel-exact
   * output.
   */
  quality?: number;
  /**
   * Alpha level-reduction cap. Default 16. The encoder also tries the
   * untouched lossless plane and keeps whichever encoding is smaller, so
   * smooth alpha gradients stay lossless automatically.
   */
  alphaLevels?: AlphaLevels;
  /**
   * Ordered-dither strength (0–1) for alpha level reduction. Reduces banding
   * on smooth alpha gradients at some alpha-payload cost; exact 0/255 pixels
   * are never affected. Default 1; pass 0 to disable.
   */
  alphaDither?: number;
  /**
   * Choose the alpha level values adaptively (Lloyd-Max, like libwebp's
   * alpha_quality) instead of a uniform grid. Min/max stay exact, and planes
   * with ≤ alphaLevels distinct values pass through losslessly. Default true.
   */
  alphaAdaptive?: boolean;
  /**
   * Lossless (VP8L, palette-based) candidate selection. With "auto" (the
   * default), images with ≤ 256 distinct colors are also encoded losslessly
   * and the smaller file wins — `quality` acts as a floor, since lossless
   * only replaces lossy when it is not larger. `true` forces lossless when
   * representable (falling back to lossy above 256 colors); `false` disables.
   */
  lossless?: boolean | "auto";
}

/**
 * Largest dimension the WebP bitstream can express: both VP8 and VP8L store
 * width/height in 14 bits, so anything above 2^14 − 1 would be silently
 * truncated into a mis-sized header.
 */
const MAX_DIMENSION = 16383;

/**
 * Reject image shapes the encoder cannot represent before they reach the
 * pixel loops: non-integer, zero/negative, or over-large dimensions would
 * produce corrupt output, and a short data buffer would read past its end.
 */
function validateImage(width: number, height: number, dataLength: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height)) {
    throw new RangeError(
      `encodeWebP: width and height must be integers (got ${width}×${height})`,
    );
  }
  if (width < 1 || height < 1) {
    throw new RangeError(
      `encodeWebP: width and height must be ≥ 1 (got ${width}×${height})`,
    );
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new RangeError(
      `encodeWebP: width and height must be ≤ ${MAX_DIMENSION} (got ${width}×${height})`,
    );
  }
  const needed = width * height * 4;
  if (dataLength < needed) {
    throw new RangeError(
      `encodeWebP: data too short — need ${needed} bytes for a ${width}×${height} ` +
        `RGBA image, got ${dataLength}`,
    );
  }
}

/**
 * Numeric options must be finite: NaN slips through comparison-based clamps
 * (`x < 0` and `x > 1` are both false) and poisons downstream math.
 * `quality` is exempt — resolveQuality absorbs any invalid value into the
 * default, matching the native canvas encoders (a slim-only throw would
 * fail only on the WebKit fallback path, the least-tested environment).
 */
function validateOptions(opts: EncodeOptions): void {
  if (opts.alphaDither !== undefined && !Number.isFinite(opts.alphaDither)) {
    throw new RangeError(`encodeWebP: alphaDither must be a finite number (got ${opts.alphaDither})`);
  }
}

/**
 * HTML spec rule for canvas image encoding ("if quality is outside the
 * range, the user agent must use its default quality value, as if the
 * quality argument had not been given"), scaled to slim's 0–100 range:
 * omitted, out-of-range, NaN, and ±Infinity all encode at the default 80
 * (NaN fails both comparisons and falls into the default branch).
 */
function resolveQuality(quality: number | undefined): number {
  return quality !== undefined && quality >= 0 && quality <= 100 ? quality : 80;
}

/**
 * Quality → quantizer index, following the shape of libwebp's
 * QualityToCompression: piecewise-linear map then a cube-root curve.
 */
function qualityToQi(quality: number): number {
  const q = (quality < 0 ? 0 : quality > 100 ? 100 : quality) / 100;
  const linear = q < 0.75 ? q * (2 / 3) : 2 * q - 1;
  const c = Math.cbrt(linear);
  return Math.round(127 * (1 - c));
}

export function encodeWebP(image: ImageDataLike, opts: EncodeOptions = {}): Uint8Array {
  const { width, height } = image;
  validateImage(width, height, image.data.length);
  validateOptions(opts);
  // View exactly width×height×4 bytes: `data` may be a longer (e.g. pooled)
  // buffer, and tail bytes must not leak into the alpha or color scans.
  const rgba = (
    image.data instanceof Uint8Array
      ? image.data
      : new Uint8Array(image.data.buffer, image.data.byteOffset, image.data.byteLength)
  ).subarray(0, width * height * 4);

  const alpha = alphaPlane(rgba);
  let hasAlpha = false;
  for (let i = 0; i < alpha.length; i++) {
    if (alpha[i] !== 255) {
      hasAlpha = true;
      break;
    }
  }

  // Lossless candidate: only representable with ≤ 256 distinct colors, where
  // it is also the content class most likely to beat lossy on size. Encodes
  // the untouched pixels — not the transparency-flattened ones — so a
  // lossless result really does round-trip the input exactly.
  const losslessMode = opts.lossless ?? "auto";
  let losslessFile: Uint8Array | null = null;
  if (losslessMode !== false) {
    const vp8l = encodeVP8L(rgba, width, height);
    if (vp8l) losslessFile = buildWebPLossless(vp8l);
    if (losslessFile && losslessMode === true) return losslessFile;
  }

  // Transparency handling mirrors libwebp (see yuv.ts): alpha-weighted
  // chroma averaging during conversion, then block-local luma smoothing
  // under the mask — not a global fill color, which washes out edge chroma.
  const yuv = rgbaToYuv420(rgba, width, height, hasAlpha ? alpha : undefined);
  if (hasAlpha) smoothTransparentAreas(yuv, alpha);
  const vp8 = encodeVP8Frame(yuv, { qi: qualityToQi(resolveQuality(opts.quality)) });

  let lossyFile: Uint8Array;
  if (!hasAlpha) {
    lossyFile = buildWebP({ width, height, vp8 });
  } else {
    const alph = encodeAlpha(
      alpha,
      width,
      height,
      opts.alphaLevels ?? 16,
      opts.alphaDither ?? 1,
      opts.alphaAdaptive ?? true,
    );
    lossyFile = buildWebP({ width, height, vp8, alph: alph.payload });
  }

  // quality acts as a floor: lossless wins whenever it is not larger
  if (losslessFile && losslessFile.length <= lossyFile.length) return losslessFile;
  return lossyFile;
}
