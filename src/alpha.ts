// Alpha plane pipeline: semi-lossy level reduction, prediction filtering,
// and ALPH chunk payload assembly (method 0 = uncompressed).
// Filter semantics match libwebp dsp/filters.c so any spec-compliant decoder
// reconstructs the quantized plane exactly.

import { encodeAlphaVP8L } from "./vp8l.ts";

export type AlphaLevels = 8 | 16 | 32;

/**
 * Default level-reduction cap, shared by the public API and the harnesses so
 * expectations can't drift from shipping behavior. 32 favors smooth
 * gradients: banding is far more visible than the payload difference.
 */
export const DEFAULT_ALPHA_LEVELS: AlphaLevels = 32;

// 4x4 Bayer matrix (values 0..15); thresholds are (v + 0.5)/16 - 0.5.
const BAYER4 = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
// 8-phase 1-D ordered-dither sequence (bit-reversal order).
const BAYER8 = [0, 4, 2, 6, 1, 5, 3, 7];

/**
 * Dither pattern: the default 4x4 Bayer, or a 1-D pattern varying along one
 * axis only. On an axis-aligned gradient the 1-D pattern leaves every row
 * (resp. column) identical, so it costs the LZ77 stage nothing — and being
 * free of the 2-D constraint it can afford 8 phases for smoother
 * transitions.
 */
export type DitherPattern = "2d" | "x" | "y";

/** Dither threshold offset in [-0.5, 0.5) for pixel (x, y). */
function ditherOffset(x: number, y: number, pattern: DitherPattern): number {
  if (pattern === "x") return (BAYER8[x & 7] + 0.5) / 8 - 0.5;
  if (pattern === "y") return (BAYER8[y & 7] + 0.5) / 8 - 0.5;
  return (BAYER4[(y & 3) * 4 + (x & 3)] + 0.5) / 16 - 0.5;
}

/**
 * Smallest gap between adjacent quantization levels worth dithering, in
 * alpha units. Below this, banding amplitude is invisible (< ~1.6% of full
 * alpha) but the dither pattern still scrambles LZ77 — e.g. a low-range
 * shadow ramp quantized adaptively can have gaps of ~2 where dithering
 * triples the payload for nothing. Dither where it can be seen, not where
 * it can't.
 */
const DITHER_MIN_GAP = 4;

/**
 * Semi-lossy level reduction. Uniform levels with 0 and 255 representable
 * exactly (step = 255/(levels-1)); quantize BEFORE the prediction filter.
 *
 * `dither` (0..1) applies ordered dithering scaled to the quantization step,
 * trading banding on smooth alpha gradients for a fine 4x4 pattern. Pixels
 * sitting exactly on a level (in particular 0 and 255) are unaffected at any
 * strength, so hard transparent/opaque regions never speckle.
 */
export function quantizeAlpha(
  alpha: Uint8Array,
  width: number,
  levels: AlphaLevels = DEFAULT_ALPHA_LEVELS,
  dither = 1,
  pattern: DitherPattern = "2d",
): Uint8Array {
  const step = 255 / (levels - 1);
  const out = new Uint8Array(alpha.length);
  if (dither <= 0) {
    const lut = new Uint8Array(256);
    for (let v = 0; v < 256; v++) {
      lut[v] = Math.round(Math.round(v / step) * step);
    }
    for (let i = 0; i < alpha.length; i++) out[i] = lut[alpha[i]];
    return out;
  }
  const strength = dither > 1 ? 1 : dither;
  for (let i = 0; i < alpha.length; i++) {
    const x = i % width;
    const y = (i / width) | 0;
    const offset = ditherOffset(x, y, pattern) * strength;
    const level = Math.round(alpha[i] / step + offset);
    const v = Math.round(level * step);
    out[i] = v < 0 ? 0 : v > 255 ? 255 : v;
  }
  return out;
}

/**
 * Adaptive (Lloyd-Max / k-means) level reduction, the same scheme libwebp's
 * alpha_quality uses: pick the N level values that minimize squared error for
 * this plane's histogram, instead of a uniform grid. Min and max observed
 * values are pinned exactly (usually 0 and 255). If the plane already has at
 * most N distinct values it is passed through untouched (lossless).
 *
 * `dither` works as in quantizeAlpha, scaled to the local gap between the
 * two bracketing levels; pixels exactly on a level never move.
 */
export function quantizeAlphaAdaptive(
  alpha: Uint8Array,
  width: number,
  levels: AlphaLevels = DEFAULT_ALPHA_LEVELS,
  dither = 1,
  pattern: DitherPattern = "2d",
): Uint8Array {
  const freq = new Uint32Array(256);
  let minS = 255;
  let maxS = 0;
  let distinct = 0;
  for (let i = 0; i < alpha.length; i++) {
    const s = alpha[i];
    if (freq[s] === 0) distinct++;
    freq[s]++;
    if (s < minS) minS = s;
    if (s > maxS) maxS = s;
  }
  if (distinct <= levels) return alpha.slice(); // already representable

  // k-means with uniformly spread initial centroids; endpoints stay pinned
  const centroid = new Float64Array(levels);
  for (let k = 0; k < levels; k++) {
    centroid[k] = minS + ((maxS - minS) * k) / (levels - 1);
  }
  let lastErr = Infinity;
  const slotOf = new Uint8Array(256);
  for (let iter = 0; iter < 6; iter++) {
    const sum = new Float64Array(levels);
    const count = new Float64Array(levels);
    let slot = 0;
    for (let s = minS; s <= maxS; s++) {
      while (slot < levels - 1 && 2 * s > centroid[slot] + centroid[slot + 1]) slot++;
      slotOf[s] = slot;
      sum[slot] += s * freq[s];
      count[slot] += freq[s];
    }
    for (let k = 1; k < levels - 1; k++) {
      if (count[k] > 0) centroid[k] = sum[k] / count[k];
    }
    let err = 0;
    for (let s = minS; s <= maxS; s++) {
      const d = s - centroid[slotOf[s]];
      err += freq[s] * d * d;
    }
    if (lastErr - err < 1e-4 * alpha.length) break;
    lastErr = err;
  }

  const level = new Uint8Array(levels);
  for (let k = 0; k < levels; k++) level[k] = Math.round(centroid[k]);
  level[0] = minS;
  level[levels - 1] = maxS;

  // per-value LUTs: bracketing lower level, fractional position in the gap,
  // and whether the local gap is wide enough for dithering to be visible
  const lowSlot = new Uint8Array(256);
  const frac = new Float64Array(256);
  const dith = new Uint8Array(256);
  {
    let k = 0;
    for (let s = minS; s <= maxS; s++) {
      while (k < levels - 2 && s >= level[k + 1]) k++;
      lowSlot[s] = k;
      const gap = level[k + 1] - level[k];
      frac[s] = gap > 0 ? (s - level[k]) / gap : 0;
      dith[s] = gap >= DITHER_MIN_GAP ? 1 : 0;
    }
  }

  const strength = dither <= 0 ? 0 : dither > 1 ? 1 : dither;
  const out = new Uint8Array(alpha.length);
  for (let i = 0; i < alpha.length; i++) {
    const s = alpha[i];
    let idx: number;
    if (strength > 0 && dith[s]) {
      const x = i % width;
      const y = (i / width) | 0;
      const offset = ditherOffset(x, y, pattern) * strength;
      idx = lowSlot[s] + Math.round(frac[s] + offset);
    } else {
      idx = lowSlot[s] + Math.round(frac[s]);
    }
    out[i] = level[idx < 0 ? 0 : idx >= levels ? levels - 1 : idx];
  }
  return out;
}

export const FILTER_NONE = 0;
export const FILTER_HORIZONTAL = 1;
export const FILTER_VERTICAL = 2;
export const FILTER_GRADIENT = 3;

function clip255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** Apply prediction filter (residual = actual - prediction, mod 256). */
export function applyAlphaFilter(
  a: Uint8Array,
  width: number,
  height: number,
  filter: number,
): Uint8Array {
  if (filter === FILTER_NONE) return a;
  const out = new Uint8Array(a.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = y * width + x;
      let pred: number;
      if (x === 0 && y === 0) {
        pred = 0;
      } else if (filter === FILTER_HORIZONTAL) {
        pred = x > 0 ? a[i - 1] : a[i - width];
      } else if (filter === FILTER_VERTICAL) {
        // first row falls back to left-prediction
        pred = y > 0 ? a[i - width] : a[i - 1];
      } else {
        // gradient: clip(left + above - above-left); borders fall back
        if (y === 0) pred = a[i - 1];
        else if (x === 0) pred = a[i - width];
        else pred = clip255(a[i - 1] + a[i - width] - a[i - width - 1]);
      }
      out[i] = (a[i] - pred) & 0xff;
    }
  }
  return out;
}

/** Shannon entropy (bits/symbol) of a byte plane — filter-selection heuristic. */
function entropy(data: Uint8Array): number {
  const hist = new Uint32Array(256);
  for (let i = 0; i < data.length; i++) hist[data[i]]++;
  let h = 0;
  for (let s = 0; s < 256; s++) {
    if (hist[s] === 0) continue;
    const p = hist[s] / data.length;
    h -= p * Math.log2(p);
  }
  return h;
}

/**
 * Estimated post-LZ77 cost of a filtered plane, in bits. Pixels equal to a
 * predecessor at one of the coder's match distances (left neighbor, row
 * above, 4 rows above — see vp8l.ts REF_DISTANCES) form match streaks;
 * everything else is a literal costed at streak-literal entropy. Two
 * details matter for ranking fidelity (mis-ranking here once cost 23% on a
 * noisy low-range ramp): streaks shorter than MIN_MATCH(4) are really
 * literals, and each surviving match pays a length+distance token (~16
 * bits) — a plane shredded into short runs is far dearer than its literal
 * count suggests.
 */
function estimateVP8LCost(data: Uint8Array, width: number): number {
  const hist = new Uint32Array(256);
  const w4 = 4 * width;
  let literals = 0;
  let matches = 0;
  let streak = 0;
  const flush = (): void => {
    if (streak >= 4) matches++;
    else literals += streak;
    streak = 0;
  };
  for (let i = 0; i < data.length; i++) {
    const v = data[i];
    if (
      (i >= 1 && v === data[i - 1]) ||
      (i >= width && v === data[i - width]) ||
      (i >= w4 && v === data[i - w4])
    ) {
      streak++;
      continue;
    }
    flush();
    hist[v]++;
    literals++;
  }
  flush();
  if (literals === 0 && matches === 0) return 0;
  let h = 0;
  for (let s = 0; s < 256; s++) {
    if (hist[s] === 0) continue;
    const p = hist[s] / Math.max(1, literals);
    h -= p * Math.log2(p);
  }
  // ~2 bits floor per literal for tree/token overhead keeps degenerate
  // single-symbol planes from all scoring identically at zero
  return literals * (h + 2) + matches * 16;
}

export interface AlphaEncodeResult {
  /** ALPH chunk payload: header byte + filtered plane. */
  payload: Uint8Array;
  filter: number;
  /** The quantized plane a compliant decoder will reconstruct exactly. */
  quantized: Uint8Array;
}

/**
 * Build a method-0 (uncompressed) ALPH payload. Tries all four prediction
 * filters and keeps the one with the smallest post-filter entropy estimate.
 */
export function encodeAlphaMethod0(
  alpha: Uint8Array,
  width: number,
  height: number,
  levels: AlphaLevels = DEFAULT_ALPHA_LEVELS,
  dither = 1,
): AlphaEncodeResult {
  const quantized = quantizeAlpha(alpha, width, levels, dither);
  let bestFilter = FILTER_NONE;
  let bestData = quantized;
  let bestH = entropy(quantized);
  for (const f of [FILTER_HORIZONTAL, FILTER_VERTICAL, FILTER_GRADIENT]) {
    const filtered = applyAlphaFilter(quantized, width, height, f);
    const h = entropy(filtered);
    if (h < bestH) {
      bestH = h;
      bestFilter = f;
      bestData = filtered;
    }
  }
  const method = 0; // uncompressed
  const preprocessing = 1; // level reduction (informational)
  const payload = new Uint8Array(1 + bestData.length);
  payload[0] = method | (bestFilter << 2) | (preprocessing << 4);
  payload.set(bestData, 1);
  return { payload, filter: bestFilter, quantized };
}

/**
 * Build the best ALPH payload: method 1 (mini-VP8L) over BOTH the level-
 * reduced plane and the untouched lossless plane, each with all four
 * prediction filters, picking the smallest actual encoding. Smooth alpha
 * gradients compress nearly for free losslessly (constant residuals after
 * prediction — pure run-length), so on such content lossless wins on size AND
 * quality; on mask-like content the quantized plane wins as usual. The
 * method-0 (uncompressed) payload remains as a final fallback.
 *
 * `levels` is therefore a cap, not a promise: the encoder keeps the plane
 * lossless whenever that is not larger.
 */
export function encodeAlpha(
  alpha: Uint8Array,
  width: number,
  height: number,
  levels: AlphaLevels = DEFAULT_ALPHA_LEVELS,
  dither = 1,
  adaptive = true,
): AlphaEncodeResult {
  const quantized = adaptive
    ? quantizeAlphaAdaptive(alpha, width, levels, dither)
    : quantizeAlpha(alpha, width, levels, dither);

  let isLossless = true;
  for (let i = 0; i < alpha.length; i++) {
    if (quantized[i] !== alpha[i]) {
      isLossless = false;
      break;
    }
  }
  // candidates ordered lossless-first so it also wins size ties
  const candidates: Array<{ plane: Uint8Array; preprocessing: number }> = isLossless
    ? [{ plane: alpha, preprocessing: 0 }]
    : [
        { plane: alpha, preprocessing: 0 },
        { plane: quantized, preprocessing: 1 /* level reduction, informational */ },
      ];
  // 2-D dithering hides banding but can defeat LZ77 outright on smooth
  // gradient planes. Rescue candidate: a 1-D dither aligned with the
  // gradient axis — rows (or columns) stay identical, so it compresses like
  // an undithered plane while still breaking up the bands. Offered only when
  // the plane is essentially one-dimensional: the mean profile across the
  // perpendicular axis must stay within half a quantization step, or the
  // pattern would leave banding it cannot fix (e.g. radial fades). Never an
  // undithered candidate — smooth gradients are where it compresses best and
  // bands worst; dithering is a quality contract, not a size heuristic.
  if (!isLossless && dither > 0) {
    // Axis from the row/column mean profiles — averaging first cancels pixel
    // noise that would otherwise swamp a gentle ramp.
    const height = alpha.length / width;
    const colMean = new Float64Array(width);
    const rowMean = new Float64Array(height);
    for (let i = 0; i < alpha.length; i++) {
      colMean[i % width] += alpha[i];
      rowMean[(i / width) | 0] += alpha[i];
    }
    const range = (p: Float64Array, n: number): number => {
      let lo = Infinity;
      let hi = -Infinity;
      for (const v of p) {
        const m = v / n;
        if (m < lo) lo = m;
        if (m > hi) hi = m;
      }
      return hi - lo;
    };
    const xRange = range(colMean, height);
    const yRange = range(rowMean, width);
    const pattern: DitherPattern = xRange >= yRange ? "x" : "y";
    const perp = pattern === "x" ? yRange : xRange;
    if (perp <= 255 / (levels - 1) / 2) {
      const lin = adaptive
        ? quantizeAlphaAdaptive(alpha, width, levels, dither, pattern)
        : quantizeAlpha(alpha, width, levels, dither, pattern);
      for (let i = 0; i < lin.length; i++) {
        if (lin[i] !== quantized[i]) {
          candidates.push({ plane: lin, preprocessing: 1 });
          break;
        }
      }
    }
  }

  let bestPayload: Uint8Array | null = null;
  let bestFilter = FILTER_NONE;
  let bestPlane = alpha;
  for (const { plane, preprocessing } of candidates) {
    // rank filters by estimated post-LZ77 cost (cheap) and fully encode
    // only the best two — halves the VP8L passes vs a full 4-filter search
    const ranked = [FILTER_NONE, FILTER_HORIZONTAL, FILTER_VERTICAL, FILTER_GRADIENT]
      .map((f) => ({ f, filtered: applyAlphaFilter(plane, width, height, f) }))
      .map((c) => ({ ...c, h: estimateVP8LCost(c.filtered, width) }))
      .sort((a, b) => a.h - b.h)
      .slice(0, 2);
    let candStream: Uint8Array | null = null;
    let candFilter = FILTER_NONE;
    for (const { f, filtered } of ranked) {
      const stream = encodeAlphaVP8L(filtered, width, height);
      if (candStream === null || stream.length < candStream.length) {
        candStream = stream;
        candFilter = f;
      }
    }
    if (bestPayload === null || candStream!.length + 1 < bestPayload.length) {
      const payload = new Uint8Array(1 + candStream!.length);
      payload[0] = 1 /* method 1 */ | (candFilter << 2) | (preprocessing << 4);
      payload.set(candStream!, 1);
      bestPayload = payload;
      bestFilter = candFilter;
      bestPlane = plane;
    }
  }
  // Method-0 fallback: an uncompressed payload is always exactly
  // 1 + width*height bytes, so it only wins when VP8L failed to compress at
  // all — and since size is fixed regardless of plane or filter, store the
  // untouched plane raw for strictly better fidelity than any quantization.
  if (1 + alpha.length < bestPayload!.length) {
    const payload = new Uint8Array(1 + alpha.length);
    payload[0] = 0; // method 0, FILTER_NONE, no preprocessing
    payload.set(alpha, 1);
    return { payload, filter: FILTER_NONE, quantized: alpha };
  }
  return { payload: bestPayload!, filter: bestFilter, quantized: bestPlane };
}

/** Extract the alpha plane from interleaved RGBA. */
export function alphaPlane(rgba: Uint8Array | Uint8ClampedArray): Uint8Array {
  const n = rgba.length / 4;
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = rgba[i * 4 + 3];
  return out;
}
