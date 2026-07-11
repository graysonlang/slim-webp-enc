// Minimal VP8 intra-keyframe encoder: 16x16 luma modes (DC/V/H/TM) + chroma
// modes selected by rate-distortion score (libwebp method-3 style), single
// segment, flat quantization, adapted probability tables, one token
// partition, MB skip, loop-filter level from QP.
// Structure follows libwebp's enc/ (frame_enc.c, syntax_enc.c, tree_enc.c)
// and RFC 6386.

import { BoolEncoder } from "./boolcoder.ts";
import {
  AC_TABLE,
  BANDS,
  CAT3,
  CAT4,
  CAT5,
  CAT6,
  COEFFS_PROBA0,
  COEFFS_UPDATE_PROBA,
  DC_TABLE,
  KB_MODES_PROBA,
  ZIGZAG,
} from "./tables.ts";
import { fdct4x4, fwht4x4, idct4x4, iwht4x4 } from "./transform.ts";
import type { YuvImage } from "./yuv.ts";

export interface Vp8Options {
  /** Quantizer index 0..127 (lower = better quality). */
  qi: number;
  /** Loop-filter strength 0..100 (cwebp -f). Default 60. */
  filterStrength?: number;
  /**
   * "quality" (default): rate-distortion mode search incl. 4x4 modes
   * (libwebp method-3 style). "fast": prediction-only 16x16/chroma mode
   * selection — ~3x faster, ~1 dB lower average PSNR at similar size.
   */
  effort?: "fast" | "quality";
}

const MAX_LEVEL = 2047;

// Prediction modes (numbering is local; bitstream bits are written explicitly)
const DC = 0;
const V = 1;
const H = 2;
const TM = 3;
/** Marker for a 4x4-mode (B_PRED) macroblock in MbData.yMode. */
const I4 = 4;
// 4x4 sub-modes use libwebp/RFC numbering: DC,TM,VE,HE,RD,VR,LD,VL,HD,HU.
// A 16x16 neighbor contributes its equivalent sub-mode as coding context:
const I16_TO_BMODE = [0, 2, 3, 1]; // DC->B_DC, V->B_VE, H->B_HE, TM->B_TM

interface QuantPair {
  dc: number;
  ac: number;
  /** Rounding biases in 1/256 units (libwebp kBiasMatrices). */
  dcBias: number;
  acBias: number;
}

function clampQ(q: number, max: number): number {
  // Round + coerce first: a NaN or fractional q would otherwise survive the
  // comparisons and index the quant tables as undefined, silently quantizing
  // every coefficient to zero.
  const qi = Math.round(q) | 0;
  return qi < 0 ? 0 : qi > max ? max : qi;
}

/** Per-frame dequantization factors (RFC 6386 §14.1), all segment deltas 0. */
function buildQuants(qi: number): { y1: QuantPair; y2: QuantPair; uv: QuantPair } {
  const q = clampQ(qi, 127);
  const y2ac = (AC_TABLE[q] * 101581) >> 16; // *155/100
  return {
    y1: { dc: DC_TABLE[q], ac: AC_TABLE[q], dcBias: 96, acBias: 110 },
    y2: { dc: DC_TABLE[q] * 2, ac: y2ac < 8 ? 8 : y2ac, dcBias: 96, acBias: 108 },
    uv: { dc: DC_TABLE[clampQ(q, 117)], ac: AC_TABLE[q], dcBias: 110, acBias: 115 },
  };
}

/**
 * Loop-filter level from QP — the shape of libwebp's SetupFilterStrength
 * with sharpness 0 (identity level table) and no per-segment complexity.
 */
function filterLevelFromQi(qi: number, strength: number): number {
  const qstep = AC_TABLE[clampQ(qi, 127)] >> 2;
  const base = qstep > 63 ? 63 : qstep;
  const f = ((base * 5 * strength) / 256) | 0;
  return f < 1 ? 0 : f > 63 ? 63 : f;
}

/** Quantized block: levels in zigzag scan order + index of last nonzero. */
interface Residual {
  levels: Int16Array; // signed levels, scan order
  last: number; // -1 if all zero
}

/**
 * Quantize `coeffs` (block order) from scan position `first`, writing
 * dequantized values back into `dequant` (block order) for reconstruction.
 */
function quantizeBlock(
  coeffs: Int16Array,
  dequant: Int16Array,
  first: number,
  q: QuantPair,
): Residual {
  const levels = new Int16Array(16);
  let last = -1;
  for (let n = first; n < 16; n++) {
    const j = ZIGZAG[n];
    const Q = n === 0 ? q.dc : q.ac;
    const bias = n === 0 ? q.dcBias : q.acBias;
    const c = coeffs[j];
    const abs = c < 0 ? -c : c;
    let level = ((abs * 256 + bias * Q) / (256 * Q)) | 0; // floor(abs/Q + bias/256)
    if (level > MAX_LEVEL) level = MAX_LEVEL;
    levels[n] = c < 0 ? -level : level;
    dequant[j] = levels[n] * Q;
    if (level) last = n;
  }
  return { levels, last };
}

// ---------------------------------------------------------------------------
// Adaptive token probabilities (libwebp FinalizeTokenProbas / RecordCoeffs)

/** stats[t][b][c][p] = [count of 1-bits, total] for each boolean branch. */
type TokenStats = Uint32Array; // flattened [4][8][3][11][2]

function statIndex(t: number, b: number, c: number, p: number): number {
  return (((t * 8 + b) * 3 + c) * 11 + p) * 2;
}

/** Approximate cost in 1/256 bits of coding `bit` with probability `proba`. */
function bitCost(bit: number, proba: number): number {
  // VP8BitCost uses a log2 table; a float approximation is fine here since
  // this only drives the update/keep decision, not the bitstream.
  const p = bit ? 255 - proba : proba;
  return Math.round(-Math.log2((p < 1 ? 1 : p) / 256) * 256);
}

/**
 * Mirror of putCoeffs that only records branch statistics (libwebp
 * VP8RecordCoeffs). Must take exactly the same branches as putCoeffs.
 */
function recordCoeffs(
  stats: TokenStats,
  ctx: number,
  type: number,
  first: number,
  res: Residual,
): number {
  const rec = (bit: number | boolean, t: number, b: number, c: number, p: number): boolean => {
    const i = statIndex(t, b, c, p);
    stats[i] += bit ? 1 : 0;
    stats[i + 1]++;
    return !!bit;
  };
  let n = first;
  let band = BANDS[n];
  if (!rec(res.last >= 0, type, band, ctx, 0)) return 0;

  while (n < 16) {
    const c = res.levels[n++];
    const sign = c < 0;
    const v = sign ? -c : c;
    if (!rec(v !== 0, type, band, ctx, 1)) {
      band = BANDS[n];
      ctx = 0;
      continue;
    }
    if (!rec(v > 1, type, band, ctx, 2)) {
      band = BANDS[n];
      ctx = 1;
    } else {
      if (!rec(v > 4, type, band, ctx, 3)) {
        if (rec(v !== 2, type, band, ctx, 4)) rec(v === 4, type, band, ctx, 5);
      } else if (!rec(v > 10, type, band, ctx, 6)) {
        rec(v > 6, type, band, ctx, 7);
        // fixed-probability bits (159/165/145) are not adaptive
      } else {
        rec(v >= 3 + (8 << 2), type, band, ctx, 8);
        if (v >= 3 + (8 << 2)) rec(v >= 3 + (8 << 3), type, band, ctx, 10);
        else rec(v >= 3 + (8 << 1), type, band, ctx, 9);
        // category extra bits use fixed CAT tables — not adaptive
      }
      band = BANDS[n];
      ctx = 2;
    }
    if (n === 16 || !rec(n <= res.last, type, band, ctx, 0)) {
      return 1;
    }
  }
  return 1;
}

/**
 * Decide per-branch whether to replace the default probability
 * (libwebp FinalizeTokenProbas). Returns the coeff probs to use.
 */
function finalizeTokenProbas(stats: TokenStats): number[][][][] {
  const probs: number[][][][] = COEFFS_PROBA0.map((t) =>
    t.map((b) => b.map((c) => c.slice())),
  );
  for (let t = 0; t < 4; t++) {
    for (let b = 0; b < 8; b++) {
      for (let c = 0; c < 3; c++) {
        for (let p = 0; p < 11; p++) {
          const i = statIndex(t, b, c, p);
          const nb = stats[i];
          const total = stats[i + 1];
          if (total === 0) continue;
          const updateProba = COEFFS_UPDATE_PROBA[t][b][c][p];
          const oldP = COEFFS_PROBA0[t][b][c][p];
          const newP = nb ? 255 - Math.floor((nb * 255) / total) : 255;
          const branchCost = (proba: number): number =>
            nb * bitCost(1, proba) + (total - nb) * bitCost(0, proba);
          const oldCost = branchCost(oldP) + bitCost(0, updateProba);
          const newCost = branchCost(newP) + bitCost(1, updateProba) + 8 * 256;
          if (oldCost > newCost) probs[t][b][c][p] = newP;
        }
      }
    }
  }
  return probs;
}

/** Port of libwebp PutCoeffs: write one block's tokens. Returns nz flag. */
function putCoeffs(
  bw: BoolEncoder,
  ctx: number,
  probs: number[][][],
  first: number,
  res: Residual,
): number {
  let n = first;
  let p = probs[n][ctx]; // BANDS[0]=0, BANDS[1]=1, so band==n for n<=1
  if (!bw.putBit(res.last >= 0, p[0])) return 0;

  while (n < 16) {
    const c = res.levels[n++];
    const sign = c < 0;
    let v = sign ? -c : c;
    if (!bw.putBit(v !== 0, p[1])) {
      p = probs[BANDS[n]][0];
      continue;
    }
    if (!bw.putBit(v > 1, p[2])) {
      p = probs[BANDS[n]][1];
    } else {
      if (!bw.putBit(v > 4, p[3])) {
        if (bw.putBit(v !== 2, p[4])) bw.putBit(v === 4, p[5]);
      } else if (!bw.putBit(v > 10, p[6])) {
        if (!bw.putBit(v > 6, p[7])) {
          bw.putBit(v === 6, 159);
        } else {
          bw.putBit(v >= 9, 165);
          bw.putBit(!(v & 1), 145);
        }
      } else {
        let mask: number;
        let tab: number[];
        if (v < 3 + (8 << 1)) {
          bw.putBit(0, p[8]);
          bw.putBit(0, p[9]);
          v -= 3 + (8 << 0);
          mask = 1 << 2;
          tab = CAT3;
        } else if (v < 3 + (8 << 2)) {
          bw.putBit(0, p[8]);
          bw.putBit(1, p[9]);
          v -= 3 + (8 << 1);
          mask = 1 << 3;
          tab = CAT4;
        } else if (v < 3 + (8 << 3)) {
          bw.putBit(1, p[8]);
          bw.putBit(0, p[10]);
          v -= 3 + (8 << 2);
          mask = 1 << 4;
          tab = CAT5;
        } else {
          bw.putBit(1, p[8]);
          bw.putBit(1, p[10]);
          v -= 3 + (8 << 3);
          mask = 1 << 10;
          tab = CAT6;
        }
        let t = 0;
        while (mask) {
          bw.putBit(v & mask, tab[t++]);
          mask >>= 1;
        }
      }
      p = probs[BANDS[n]][2];
    }
    bw.putBitUniform(sign);
    if (n === 16 || !bw.putBit(n <= res.last, p[0])) {
      return 1; // EOB
    }
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Rate-distortion mode selection (libwebp PickBestIntra16 / PickBestUV at
// method 3: no trellis, no spectral distortion term). Score in libwebp units:
// (rate + header) * lambda + 256 * SSE, rate in 1/256-bit units.

/** Mirror of putCoeffs that sums bit costs instead of writing (VP8GetResidualCost). */
function costCoeffs(ctx: number, probs: number[][][], first: number, res: Residual): number {
  let n = first;
  let p = probs[n][ctx];
  let cost = bitCost(res.last >= 0 ? 1 : 0, p[0]);
  if (res.last < 0) return cost;

  while (n < 16) {
    const c = res.levels[n++];
    let v = c < 0 ? -c : c;
    if (v === 0) {
      cost += bitCost(0, p[1]);
      p = probs[BANDS[n]][0];
      continue;
    }
    cost += bitCost(1, p[1]);
    if (v === 1) {
      cost += bitCost(0, p[2]);
      p = probs[BANDS[n]][1];
    } else {
      cost += bitCost(1, p[2]);
      if (v <= 4) {
        cost += bitCost(0, p[3]);
        if (v === 2) cost += bitCost(0, p[4]);
        else cost += bitCost(1, p[4]) + bitCost(v === 4 ? 1 : 0, p[5]);
      } else if (v <= 10) {
        cost += bitCost(1, p[3]) + bitCost(0, p[6]);
        if (v <= 6) cost += bitCost(0, p[7]) + bitCost(v === 6 ? 1 : 0, 159);
        else cost += bitCost(1, p[7]) + bitCost(v >= 9 ? 1 : 0, 165) + bitCost(v & 1 ? 0 : 1, 145);
      } else {
        cost += bitCost(1, p[3]) + bitCost(1, p[6]);
        let mask: number;
        let tab: number[];
        if (v < 3 + (8 << 1)) {
          cost += bitCost(0, p[8]) + bitCost(0, p[9]);
          v -= 3 + (8 << 0); mask = 1 << 2; tab = CAT3;
        } else if (v < 3 + (8 << 2)) {
          cost += bitCost(0, p[8]) + bitCost(1, p[9]);
          v -= 3 + (8 << 1); mask = 1 << 3; tab = CAT4;
        } else if (v < 3 + (8 << 3)) {
          cost += bitCost(1, p[8]) + bitCost(0, p[10]);
          v -= 3 + (8 << 2); mask = 1 << 4; tab = CAT5;
        } else {
          cost += bitCost(1, p[8]) + bitCost(1, p[10]);
          v -= 3 + (8 << 3); mask = 1 << 10; tab = CAT6;
        }
        let t = 0;
        while (mask) {
          cost += bitCost(v & mask ? 1 : 0, tab[t++]);
          mask >>= 1;
        }
      }
      p = probs[BANDS[n]][2];
    }
    cost += 256; // sign, uniform
    if (n === 16) break;
    const more = n <= res.last;
    cost += bitCost(more ? 1 : 0, p[0]);
    if (!more) break;
  }
  return cost;
}

// Mode-signaling costs from the keyframe mode trees (kVP8FixedCostsI16 /
// kVP8FixedCostsUV equivalents; luma includes the shared "not B_PRED" bit).
const COST_Y16 = [
  bitCost(1, 145) + bitCost(0, 156) + bitCost(0, 163), // DC
  bitCost(1, 145) + bitCost(0, 156) + bitCost(1, 163), // V
  bitCost(1, 145) + bitCost(1, 156) + bitCost(0, 128), // H
  bitCost(1, 145) + bitCost(1, 156) + bitCost(1, 128), // TM
];
const COST_UV = [
  bitCost(0, 142), // DC
  bitCost(1, 142) + bitCost(0, 114), // V
  bitCost(1, 142) + bitCost(1, 114) + bitCost(0, 183), // H
  bitCost(1, 142) + bitCost(1, 114) + bitCost(1, 183), // TM
];

// libwebp's FLATNESS_PENALTY is deliberately not ported: at slim's operating
// point it only pushed flat-ish MBs to DC, costing bytes with no PSNR gain.

/** SSE between a plane block at (x,y) and a dense size×size prediction. */
function ssePred(
  src: Uint8Array,
  stride: number,
  x: number,
  y: number,
  size: number,
  pred: Uint8Array,
): number {
  let s = 0;
  for (let r = 0; r < size; r++) {
    const o = (y + r) * stride + x;
    const po = r * size;
    for (let c = 0; c < size; c++) {
      const d = src[o + c] - pred[po + c];
      s += d * d;
    }
  }
  return s;
}

/** Sum of squared differences between two planes over a w×h block at (x,y). */
function sseBlock(
  a: Uint8Array,
  b: Uint8Array,
  stride: number,
  x: number,
  y: number,
  w: number,
  h: number,
): number {
  let s = 0;
  for (let r = 0; r < h; r++) {
    const o = (y + r) * stride + x;
    for (let c = 0; c < w; c++) {
      const d = a[o + c] - b[o + c];
      s += d * d;
    }
  }
  return s;
}

function clip255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/**
 * Build the intra prediction for one NxN block into `pred` (stride = size).
 * Edge conventions per RFC 6386 §12.2 / libwebp frame_dec.c: missing top row
 * = 127, missing left column = 129, top-left = 129 unless on the top row.
 */
function buildPrediction(
  mode: number,
  recon: Uint8Array,
  stride: number,
  x: number,
  y: number,
  size: number,
  hasTop: boolean,
  hasLeft: boolean,
  pred: Uint8Array,
): void {
  if (mode === DC) {
    let dc: number;
    if (hasTop || hasLeft) {
      let sum = 0;
      if (hasTop) for (let i = 0; i < size; i++) sum += recon[(y - 1) * stride + x + i];
      if (hasLeft) for (let i = 0; i < size; i++) sum += recon[(y + i) * stride + x - 1];
      const shift = (size === 16 ? 4 : 3) + (hasTop && hasLeft ? 1 : 0);
      dc = (sum + (1 << (shift - 1))) >> shift;
    } else {
      dc = 128;
    }
    pred.fill(dc, 0, size * size);
    return;
  }
  if (mode === V) {
    for (let c = 0; c < size; c++) {
      const t = hasTop ? recon[(y - 1) * stride + x + c] : 127;
      for (let r = 0; r < size; r++) pred[r * size + c] = t;
    }
    return;
  }
  if (mode === H) {
    for (let r = 0; r < size; r++) {
      const l = hasLeft ? recon[(y + r) * stride + x - 1] : 129;
      pred.fill(l, r * size, r * size + size);
    }
    return;
  }
  // TM
  const tl = !hasTop ? 127 : hasLeft ? recon[(y - 1) * stride + x - 1] : 129;
  for (let r = 0; r < size; r++) {
    const l = hasLeft ? recon[(y + r) * stride + x - 1] : 129;
    for (let c = 0; c < size; c++) {
      const t = hasTop ? recon[(y - 1) * stride + x + c] : 127;
      pred[r * size + c] = clip255(l + t - tl);
    }
  }
}

// ---------------------------------------------------------------------------
// 4x4 (B_PRED) prediction — ports of libwebp dsp/enc.c Intra4Preds. All ten
// predictors read a 13-sample boundary through `t`, an index into the 37-byte
// boundary cache `bnd` (libwebp i4_boundary_): bnd[t-5..t-2] = left column
// (bottom-up), bnd[t-1] = top-left, bnd[t..t+3] = top row, bnd[t+4..t+7] =
// top-right.

/** Sub-block top-left boundary index for each of the 16 blocks (VP8TopLeftI4). */
const TOPLEFT_I4 = [17, 21, 25, 29, 13, 17, 21, 25, 9, 13, 17, 21, 5, 9, 13, 17];

function avg3(a: number, b: number, c: number): number {
  return (a + 2 * b + c + 2) >> 2;
}
function avg2(a: number, b: number): number {
  return (a + b + 1) >> 1;
}

/**
 * Build the 4x4 prediction for sub-mode `mode` into a stride-16 MB-local
 * buffer at `off` (so fdct/idct can run in place against it).
 */
function buildPrediction4(
  mode: number,
  bnd: Uint8Array,
  t: number,
  dst: Uint8Array,
  off: number,
): void {
  const X = bnd[t - 1];
  const I = bnd[t - 2];
  const J = bnd[t - 3];
  const K = bnd[t - 4];
  const L = bnd[t - 5];
  const A = bnd[t];
  const B = bnd[t + 1];
  const C = bnd[t + 2];
  const D = bnd[t + 3];
  const set = (x: number, y: number, v: number): void => {
    dst[off + y * 16 + x] = v;
  };
  switch (mode) {
    case 0: { // DC
      const dc = (4 + A + B + C + D + I + J + K + L) >> 3;
      for (let y = 0; y < 4; y++) dst.fill(dc, off + y * 16, off + y * 16 + 4);
      break;
    }
    case 1: { // TM
      const left = [I, J, K, L];
      for (let y = 0; y < 4; y++) {
        for (let x = 0; x < 4; x++) set(x, y, clip255(left[y] + bnd[t + x] - X));
      }
      break;
    }
    case 2: { // VE
      const v0 = avg3(X, A, B);
      const v1 = avg3(A, B, C);
      const v2 = avg3(B, C, D);
      const v3 = avg3(C, D, bnd[t + 4]);
      for (let y = 0; y < 4; y++) {
        set(0, y, v0); set(1, y, v1); set(2, y, v2); set(3, y, v3);
      }
      break;
    }
    case 3: { // HE
      const r0 = avg3(X, I, J);
      const r1 = avg3(I, J, K);
      const r2 = avg3(J, K, L);
      const r3 = avg3(K, L, L);
      for (let x = 0; x < 4; x++) {
        set(x, 0, r0); set(x, 1, r1); set(x, 2, r2); set(x, 3, r3);
      }
      break;
    }
    case 4: // RD
      set(0, 3, avg3(J, K, L));
      set(0, 2, avg3(I, J, K)); set(1, 3, avg3(I, J, K));
      set(0, 1, avg3(X, I, J)); set(1, 2, avg3(X, I, J)); set(2, 3, avg3(X, I, J));
      set(0, 0, avg3(A, X, I)); set(1, 1, avg3(A, X, I)); set(2, 2, avg3(A, X, I)); set(3, 3, avg3(A, X, I));
      set(1, 0, avg3(B, A, X)); set(2, 1, avg3(B, A, X)); set(3, 2, avg3(B, A, X));
      set(2, 0, avg3(C, B, A)); set(3, 1, avg3(C, B, A));
      set(3, 0, avg3(D, C, B));
      break;
    case 5: // VR
      set(0, 0, avg2(X, A)); set(1, 2, avg2(X, A));
      set(1, 0, avg2(A, B)); set(2, 2, avg2(A, B));
      set(2, 0, avg2(B, C)); set(3, 2, avg2(B, C));
      set(3, 0, avg2(C, D));
      set(0, 3, avg3(K, J, I));
      set(0, 2, avg3(J, I, X));
      set(0, 1, avg3(I, X, A)); set(1, 3, avg3(I, X, A));
      set(1, 1, avg3(X, A, B)); set(2, 3, avg3(X, A, B));
      set(2, 1, avg3(A, B, C)); set(3, 3, avg3(A, B, C));
      set(3, 1, avg3(B, C, D));
      break;
    case 6: { // LD
      const E = bnd[t + 4];
      const F = bnd[t + 5];
      const G = bnd[t + 6];
      const Hh = bnd[t + 7];
      set(0, 0, avg3(A, B, C));
      set(1, 0, avg3(B, C, D)); set(0, 1, avg3(B, C, D));
      set(2, 0, avg3(C, D, E)); set(1, 1, avg3(C, D, E)); set(0, 2, avg3(C, D, E));
      set(3, 0, avg3(D, E, F)); set(2, 1, avg3(D, E, F)); set(1, 2, avg3(D, E, F)); set(0, 3, avg3(D, E, F));
      set(3, 1, avg3(E, F, G)); set(2, 2, avg3(E, F, G)); set(1, 3, avg3(E, F, G));
      set(3, 2, avg3(F, G, Hh)); set(2, 3, avg3(F, G, Hh));
      set(3, 3, avg3(G, Hh, Hh));
      break;
    }
    case 7: { // VL
      const E = bnd[t + 4];
      const F = bnd[t + 5];
      const G = bnd[t + 6];
      const Hh = bnd[t + 7];
      set(0, 0, avg2(A, B));
      set(1, 0, avg2(B, C)); set(0, 2, avg2(B, C));
      set(2, 0, avg2(C, D)); set(1, 2, avg2(C, D));
      set(3, 0, avg2(D, E)); set(2, 2, avg2(D, E));
      set(0, 1, avg3(A, B, C));
      set(1, 1, avg3(B, C, D)); set(0, 3, avg3(B, C, D));
      set(2, 1, avg3(C, D, E)); set(1, 3, avg3(C, D, E));
      set(3, 1, avg3(D, E, F)); set(2, 3, avg3(D, E, F));
      set(3, 2, avg3(E, F, G));
      set(3, 3, avg3(F, G, Hh));
      break;
    }
    case 8: // HD
      set(0, 0, avg2(I, X)); set(2, 1, avg2(I, X));
      set(0, 1, avg2(J, I)); set(2, 2, avg2(J, I));
      set(0, 2, avg2(K, J)); set(2, 3, avg2(K, J));
      set(0, 3, avg2(L, K));
      set(3, 0, avg3(A, B, C));
      set(2, 0, avg3(X, A, B));
      set(1, 0, avg3(I, X, A)); set(3, 1, avg3(I, X, A));
      set(1, 1, avg3(J, I, X)); set(3, 2, avg3(J, I, X));
      set(1, 2, avg3(K, J, I)); set(3, 3, avg3(K, J, I));
      set(1, 3, avg3(L, K, J));
      break;
    default: // 9: HU
      set(0, 0, avg2(I, J));
      set(2, 0, avg2(J, K)); set(0, 1, avg2(J, K));
      set(2, 1, avg2(K, L)); set(0, 2, avg2(K, L));
      set(1, 0, avg3(I, J, K));
      set(3, 0, avg3(J, K, L)); set(1, 1, avg3(J, K, L));
      set(3, 1, avg3(K, L, L)); set(1, 2, avg3(K, L, L));
      set(3, 2, L); set(2, 2, L);
      set(0, 3, L); set(1, 3, L); set(2, 3, L); set(3, 3, L);
      break;
  }
}

/** Write one 4x4 sub-mode with the keyframe tree (libwebp PutI4Mode). */
function putI4Mode(bw: BoolEncoder, mode: number, p: number[]): void {
  if (bw.putBit(mode !== 0, p[0])) {
    if (bw.putBit(mode !== 1, p[1])) {
      if (bw.putBit(mode !== 2, p[2])) {
        if (!bw.putBit(mode >= 6, p[3])) {
          if (bw.putBit(mode !== 3, p[4])) bw.putBit(mode !== 4, p[5]);
        } else {
          if (bw.putBit(mode !== 6, p[6])) {
            if (bw.putBit(mode !== 7, p[7])) bw.putBit(mode !== 8, p[8]);
          }
        }
      }
    }
  }
}

/** Cost in 1/256 bits of putI4Mode's bit sequence. */
function i4ModeCost(mode: number, p: number[]): number {
  if (mode === 0) return bitCost(0, p[0]);
  let c = bitCost(1, p[0]);
  if (mode === 1) return c + bitCost(0, p[1]);
  c += bitCost(1, p[1]);
  if (mode === 2) return c + bitCost(0, p[2]);
  c += bitCost(1, p[2]);
  if (mode < 6) {
    c += bitCost(0, p[3]);
    if (mode === 3) return c + bitCost(0, p[4]);
    return c + bitCost(1, p[4]) + bitCost(mode !== 4 ? 1 : 0, p[5]);
  }
  c += bitCost(1, p[3]);
  if (mode === 6) return c + bitCost(0, p[6]);
  c += bitCost(1, p[6]);
  if (mode === 7) return c + bitCost(0, p[7]);
  return c + bitCost(1, p[7]) + bitCost(mode !== 8 ? 1 : 0, p[8]);
}

// Precomputed kVP8FixedCostsI4 equivalent: [above][left][mode] -> cost.
const COST_I4: number[][][] = KB_MODES_PROBA.map((row) =>
  row.map((p) => Array.from({ length: 10 }, (_, m) => i4ModeCost(m, p))),
);

// Per-MB cap on 4x4 mode-signaling cost (libwebp max_i4_header_bits_ with
// default config: 16 bits per sub-block).
const MAX_I4_HEADER_BITS = 256 * 16 * 16;

/** Copy a w×h block out of a plane into a dense size-stride buffer. */
function copyReconToBlock(
  recon: Uint8Array,
  stride: number,
  x: number,
  y: number,
  size: number,
  out: Uint8Array,
): void {
  for (let r = 0; r < size; r++) {
    const o = (y + r) * stride + x;
    out.set(recon.subarray(o, o + size), r * size);
  }
}

function copyPredToRecon(
  pred: Uint8Array,
  recon: Uint8Array,
  stride: number,
  x: number,
  y: number,
  size: number,
): void {
  for (let r = 0; r < size; r++) {
    recon.set(pred.subarray(r * size, r * size + size), (y + r) * stride + x);
  }
}

interface MbData {
  yMode: number; // 0..3 (16x16 modes) or I4 (B_PRED)
  i4Modes: Uint8Array | null; // 16 sub-modes, raster order, when yMode === I4
  uvMode: number;
  skip: boolean;
  y2: Residual | null; // null for B_PRED macroblocks (no WHT stage)
  luma: Residual[]; // 16, raster order; coded from scan 1 (i16) or 0 (B_PRED)
  uv: Residual[]; // 4 U then 4 V
}

/** Encode a padded YUV420 image as a VP8 keyframe ("VP8 " chunk payload). */
export function encodeVP8Frame(yuv: YuvImage, opts: Vp8Options, allowI4 = true): Uint8Array {
  const { mbW, mbH, yStride, uvStride } = yuv;
  const qi = clampQ(opts.qi, 127);
  const quants = buildQuants(qi);
  const filterLevel = filterLevelFromQi(qi, opts.filterStrength ?? 60);

  // Reconstruction planes (what the decoder will see) — prediction sources.
  const reconY = new Uint8Array(yuv.y.length);
  const reconU = new Uint8Array(yuv.u.length);
  const reconV = new Uint8Array(yuv.v.length);

  const coeffs = new Int16Array(16);
  const dcs = new Int16Array(16);
  const y2raw = new Int16Array(16);
  const y2dq = new Int16Array(16);
  const pred16 = new Uint8Array(256);
  const best16 = new Uint8Array(256);
  const predU = new Uint8Array(64);
  const predV = new Uint8Array(64);
  const bestU = new Uint8Array(64);
  const bestV = new Uint8Array(64);
  // Per-MB dequant scratch, reused across macroblocks: quantizeBlock and the
  // explicit [0] = dcs[b] write cover every element before idct reads it.
  const lumaDq: Int16Array[] = Array.from({ length: 16 }, () => new Int16Array(16));
  const uvDq = new Int16Array(16);

  // RD lambdas from the average quantizer step of each matrix (libwebp
  // ExpandMatrix / SetupMatrices; tlambda is 0 below method 4).
  const avgQ = (p: QuantPair) => (p.dc + 15 * p.ac + 8) >> 4;
  // Scaled down 16x from libwebp's 3q²: our rate estimate uses default
  // probabilities in a single pass (libwebp converges its probabilities over
  // passes), so full-strength lambda amplifies estimate noise into
  // Pareto-worse mode picks — measured λ/16 gives the same bytes at ~1.8 dB
  // better PSNR on the syseval calibration set.
  const lambdaI16 = Math.max(1, (3 * avgQ(quants.y2) * avgQ(quants.y2)) >> 4);
  const lambdaUV = Math.max(1, (3 * avgQ(quants.uv) * avgQ(quants.uv)) >> 10);
  const lambdaI4 = Math.max(1, (3 * avgQ(quants.y1) * avgQ(quants.y1)) >> 11);
  // The i4-vs-i16 arbiter (libwebp lambda_mode_) stays at full strength: the
  // rate difference between the two is large and real, unlike the per-mode
  // estimate noise the λ/16 scaling compensates for.
  const lambdaMode = Math.max(1, (avgQ(quants.y1) * avgQ(quants.y1)) >> 7);
  // Cost estimation uses the default probabilities; the adapted set is only
  // known after mode decisions (pass 1.5), same as libwebp's first pass.
  const costY2 = COEFFS_PROBA0[1] as number[][][];
  const costYnoDC = COEFFS_PROBA0[0] as number[][][];
  const costUV = COEFFS_PROBA0[2] as number[][][];
  const costI4 = COEFFS_PROBA0[3] as number[][][];
  // nz contexts for rate estimation, tracked like the token pass (no skip
  // zeroing here — skip is decided after the modes are).
  const costTopNz: number[][] = Array.from({ length: mbW }, () => new Array(9).fill(0));
  // 4x4 mode-coding contexts (decoder resets left to B_DC each row).
  const topBModes = new Uint8Array(mbW * 4);
  const leftBModes = new Uint8Array(4);
  // i4 scratch: MB-local dense (stride 16) source/recon, boundary cache,
  // per-block prediction/recon/dequant.
  const srcMb = new Uint8Array(256);
  const i4Recon = new Uint8Array(256);
  const bnd = new Uint8Array(37);
  const blk4 = new Uint8Array(16);
  const dq4 = new Int16Array(16);

  // Transform + quantize one MB against the prediction currently sitting in
  // the recon plane(s), reconstructing in place. Shared by the RD candidate
  // loops and the fast path.
  const lumaTransform = (yx: number, yy: number): { luma: Residual[]; y2: Residual } => {
    const luma: Residual[] = new Array(16);
    for (let b = 0; b < 16; b++) {
      const off = (yy + (b >> 2) * 4) * yStride + yx + (b & 3) * 4;
      fdct4x4(yuv.y, off, reconY, off, yStride, coeffs);
      dcs[b] = coeffs[0];
      luma[b] = quantizeBlock(coeffs, lumaDq[b], 1, quants.y1);
    }
    fwht4x4(dcs, y2raw);
    const y2 = quantizeBlock(y2raw, y2dq, 0, quants.y2);
    iwht4x4(y2dq, dcs);
    for (let b = 0; b < 16; b++) {
      const off = (yy + (b >> 2) * 4) * yStride + yx + (b & 3) * 4;
      lumaDq[b][0] = dcs[b];
      idct4x4(lumaDq[b], reconY, off, yStride, reconY, off);
    }
    return { luma, y2 };
  };
  const uvTransform = (cx: number, cy: number): Residual[] => {
    const uv: Residual[] = new Array(8);
    for (let ch = 0; ch < 2; ch++) {
      const src = ch === 0 ? yuv.u : yuv.v;
      const recon = ch === 0 ? reconU : reconV;
      for (let b = 0; b < 4; b++) {
        const off = (cy + (b >> 1) * 4) * uvStride + cx + (b & 1) * 4;
        fdct4x4(src, off, recon, off, uvStride, coeffs);
        uv[ch * 4 + b] = quantizeBlock(coeffs, uvDq, 0, quants.uv);
        idct4x4(uvDq, recon, off, uvStride, recon, off);
      }
    }
    return uv;
  };

  const fast = opts.effort === "fast";
  const tryI4 = allowI4 && !fast;

  // ---- pass 1: mode decision, transform/quantize, reconstruction ----
  const mbs: MbData[] = new Array(mbW * mbH);
  let nbSkip = 0;

  for (let mby = 0; mby < mbH; mby++) {
    const costLeftNz: number[] = new Array(9).fill(0);
    leftBModes.fill(0); // decoder resets left 4x4-mode contexts each row
    for (let mbx = 0; mbx < mbW; mbx++) {
      const hasTop = mby > 0;
      const hasLeft = mbx > 0;
      const yx = mbx * 16;
      const yy = mby * 16;
      const cx = mbx * 8;
      const cy = mby * 8;
      const tnzC = costTopNz[mbx];

      let yMode = DC;
      let y2!: Residual;
      let luma!: Residual[];
      let uvMode = DC;
      let uv!: Residual[];
      let i4Modes: Uint8Array | null = null;

      if (fast) {
        // ---- fast path: modes by prediction SSE alone, single transform ----
        let bestD = Infinity;
        for (let m = 0; m < 4; m++) {
          buildPrediction(m, reconY, yStride, yx, yy, 16, hasTop, hasLeft, pred16);
          const d = ssePred(yuv.y, yStride, yx, yy, 16, pred16);
          if (d < bestD) {
            bestD = d;
            yMode = m;
            best16.set(pred16);
          }
        }
        copyPredToRecon(best16, reconY, yStride, yx, yy, 16);
        ({ luma, y2 } = lumaTransform(yx, yy));
        let bestUvD = Infinity;
        for (let m = 0; m < 4; m++) {
          buildPrediction(m, reconU, uvStride, cx, cy, 8, hasTop, hasLeft, predU);
          buildPrediction(m, reconV, uvStride, cx, cy, 8, hasTop, hasLeft, predV);
          const d =
            ssePred(yuv.u, uvStride, cx, cy, 8, predU) +
            ssePred(yuv.v, uvStride, cx, cy, 8, predV);
          if (d < bestUvD) {
            bestUvD = d;
            uvMode = m;
            bestU.set(predU);
            bestV.set(predV);
          }
        }
        copyPredToRecon(bestU, reconU, uvStride, cx, cy, 8);
        copyPredToRecon(bestV, reconV, uvStride, cx, cy, 8);
        uv = uvTransform(cx, cy);
      } else {
        // luma: reconstruct with each 16x16 mode and keep the best RD score
        let bestScore = Infinity;
        let i16Rate = 0;
        let i16Dist = 0;
        const bestTnz = [0, 0, 0, 0];
        const bestLnz = [0, 0, 0, 0];
        let bestY2Nz = 0;
        for (let m = 0; m < 4; m++) {
          buildPrediction(m, reconY, yStride, yx, yy, 16, hasTop, hasLeft, pred16);
          copyPredToRecon(pred16, reconY, yStride, yx, yy, 16);
          const { luma: candLuma, y2: candY2 } = lumaTransform(yx, yy);
          const dist = sseBlock(yuv.y, reconY, yStride, yx, yy, 16, 16);
          const y2Nz = candY2.last >= 0 ? 1 : 0;
          let rate = costCoeffs(tnzC[8] + costLeftNz[8], costY2, 0, candY2);
          const t4 = [tnzC[0], tnzC[1], tnzC[2], tnzC[3]];
          const l4 = [costLeftNz[0], costLeftNz[1], costLeftNz[2], costLeftNz[3]];
          for (let by = 0; by < 4; by++) {
            for (let bx = 0; bx < 4; bx++) {
              const r = candLuma[by * 4 + bx];
              rate += costCoeffs(t4[bx] + l4[by], costYnoDC, 1, r);
              t4[bx] = l4[by] = r.last >= 0 ? 1 : 0;
            }
          }
          const score = (rate + COST_Y16[m]) * lambdaI16 + 256 * dist;
          if (score < bestScore) {
            bestScore = score;
            yMode = m;
            y2 = candY2;
            luma = candLuma;
            i16Rate = rate + COST_Y16[m];
            i16Dist = dist;
            copyReconToBlock(reconY, yStride, yx, yy, 16, best16);
            for (let i = 0; i < 4; i++) {
              bestTnz[i] = t4[i];
              bestLnz[i] = l4[i];
            }
            bestY2Nz = y2Nz;
          }
        }

        // 4x4 (B_PRED) challenger — libwebp PickBestIntra4: pick each
        // sub-block's best of the ten modes with λ_i4, accumulate rate and
        // distortion in λ_mode currency, and bail back to the i16 winner the
        // moment the running total can't beat it.
        if (tryI4) {
          // the i16 comparison score, re-priced with λ_mode (libwebp
          // finalizes PickBestIntra16's score the same way)
          const i16Score = i16Rate * lambdaMode + 256 * i16Dist;
          copyReconToBlock(yuv.y, yStride, yx, yy, 16, srcMb);
          // boundary cache (libwebp VP8IteratorStartI4): [0..15] left column
          // bottom-up, [16] top-left, [17..32] top row, [33..36] top-right
          for (let i = 0; i < 16; i++) {
            bnd[i] = hasLeft ? reconY[(yy + 15 - i) * yStride + yx - 1] : 129;
          }
          bnd[16] = !hasTop ? 127 : hasLeft ? reconY[(yy - 1) * yStride + yx - 1] : 129;
          for (let i = 0; i < 16; i++) {
            bnd[17 + i] = hasTop ? reconY[(yy - 1) * yStride + yx + i] : 127;
          }
          for (let i = 16; i < 20; i++) {
            bnd[17 + i] =
              hasTop && mbx < mbW - 1 ? reconY[(yy - 1) * yStride + yx + i] : bnd[17 + 15];
          }

          const modes = new Uint8Array(16);
          const candLuma: Residual[] = new Array(16);
          let accRH = 211; // the B_PRED-signal bit (0 @ proba 145)
          let accD = 0;
          let headerBits = 0;
          const t4 = [tnzC[0], tnzC[1], tnzC[2], tnzC[3]];
          const l4 = [costLeftNz[0], costLeftNz[1], costLeftNz[2], costLeftNz[3]];
          let complete = true;
          for (let b = 0; b < 16; b++) {
            const bx = b & 3;
            const by = b >> 2;
            const off = by * 64 + bx * 4; // stride-16 MB-local offset
            const tIdx = TOPLEFT_I4[b];
            const above = by === 0 ? topBModes[mbx * 4 + bx] : modes[b - 4];
            const left = bx === 0 ? leftBModes[by] : modes[b - 1];
            const modeCosts = COST_I4[above][left];
            const ctx = t4[bx] + l4[by];
            let blkScore = Infinity;
            let blkMode = 0;
            let blkRes!: Residual;
            let blkR = 0;
            let blkD = 0;
            for (let m = 0; m < 10; m++) {
              buildPrediction4(m, bnd, tIdx, i4Recon, off);
              fdct4x4(srcMb, off, i4Recon, off, 16, coeffs);
              const res = quantizeBlock(coeffs, dq4, 0, quants.y1);
              idct4x4(dq4, i4Recon, off, 16, i4Recon, off);
              let d = 0;
              for (let r = 0; r < 4; r++) {
                const o = off + r * 16;
                for (let c = 0; c < 4; c++) {
                  const diff = srcMb[o + c] - i4Recon[o + c];
                  d += diff * diff;
                }
              }
              // cheap early check before the coefficient-cost walk
              let score = modeCosts[m] * lambdaI4 + 256 * d;
              if (score >= blkScore) continue;
              const rCoef = costCoeffs(ctx, costI4, 0, res);
              score += rCoef * lambdaI4;
              if (score < blkScore) {
                blkScore = score;
                blkMode = m;
                blkRes = res;
                blkR = rCoef;
                blkD = d;
                for (let r = 0; r < 4; r++) {
                  blk4.set(i4Recon.subarray(off + r * 16, off + r * 16 + 4), r * 4);
                }
              }
            }
            // restore the winning reconstruction (a later candidate may have
            // overwritten it) and advance the boundary cache (RotateI4)
            for (let r = 0; r < 4; r++) {
              i4Recon.set(blk4.subarray(r * 4, r * 4 + 4), off + r * 16);
            }
            for (let i = 0; i < 4; i++) bnd[tIdx - 4 + i] = blk4[12 + i];
            if (bx !== 3) {
              for (let i = 0; i < 3; i++) bnd[tIdx + i] = blk4[3 + (2 - i) * 4];
            } else {
              for (let i = 0; i < 4; i++) bnd[tIdx + i] = bnd[tIdx + i + 4];
            }
            modes[b] = blkMode;
            candLuma[b] = blkRes;
            t4[bx] = l4[by] = blkRes.last >= 0 ? 1 : 0;
            accRH += blkR + modeCosts[blkMode];
            accD += blkD;
            headerBits += modeCosts[blkMode];
            if (accRH * lambdaMode + 256 * accD >= i16Score || headerBits > MAX_I4_HEADER_BITS) {
              complete = false;
              break;
            }
          }
          if (complete) {
            yMode = I4;
            i4Modes = modes;
            luma = candLuma;
            for (let i = 0; i < 4; i++) {
              bestTnz[i] = t4[i];
              bestLnz[i] = l4[i];
            }
            copyPredToRecon(i4Recon, reconY, yStride, yx, yy, 16);
          }
        }

        if (yMode !== I4) {
          copyPredToRecon(best16, reconY, yStride, yx, yy, 16);
          tnzC[8] = costLeftNz[8] = bestY2Nz;
        }
        for (let i = 0; i < 4; i++) {
          tnzC[i] = bestTnz[i];
          costLeftNz[i] = bestLnz[i];
        }
        // 4x4 mode contexts for the following macroblocks
        if (i4Modes) {
          for (let i = 0; i < 4; i++) {
            topBModes[mbx * 4 + i] = i4Modes[12 + i];
            leftBModes[i] = i4Modes[i * 4 + 3];
          }
        } else {
          const bm = I16_TO_BMODE[yMode];
          topBModes.fill(bm, mbx * 4, mbx * 4 + 4);
          leftBModes.fill(bm);
        }

        // chroma: joint RD over U and V
        let bestUvScore = Infinity;
        const bestUvNz = [0, 0, 0, 0, 0, 0, 0, 0]; // t0,t1,l0,l1 for U then V
        for (let m = 0; m < 4; m++) {
          buildPrediction(m, reconU, uvStride, cx, cy, 8, hasTop, hasLeft, predU);
          buildPrediction(m, reconV, uvStride, cx, cy, 8, hasTop, hasLeft, predV);
          copyPredToRecon(predU, reconU, uvStride, cx, cy, 8);
          copyPredToRecon(predV, reconV, uvStride, cx, cy, 8);
          const candUv = uvTransform(cx, cy);
          let rate = 0;
          let dist = 0;
          const nz = [0, 0, 0, 0, 0, 0, 0, 0];
          for (let ch = 0; ch < 2; ch++) {
            const src = ch === 0 ? yuv.u : yuv.v;
            const recon = ch === 0 ? reconU : reconV;
            const t2 = [tnzC[4 + 2 * ch], tnzC[5 + 2 * ch]];
            const l2 = [costLeftNz[4 + 2 * ch], costLeftNz[5 + 2 * ch]];
            for (let b = 0; b < 4; b++) {
              const bx = b & 1;
              const by = b >> 1;
              const r = candUv[ch * 4 + b];
              rate += costCoeffs(t2[bx] + l2[by], costUV, 0, r);
              t2[bx] = l2[by] = r.last >= 0 ? 1 : 0;
            }
            nz[ch * 4] = t2[0];
            nz[ch * 4 + 1] = t2[1];
            nz[ch * 4 + 2] = l2[0];
            nz[ch * 4 + 3] = l2[1];
            dist += sseBlock(src, recon, uvStride, cx, cy, 8, 8);
          }
          const score = (rate + COST_UV[m]) * lambdaUV + 256 * dist;
          if (score < bestUvScore) {
            bestUvScore = score;
            uvMode = m;
            uv = candUv;
            copyReconToBlock(reconU, uvStride, cx, cy, 8, bestU);
            copyReconToBlock(reconV, uvStride, cx, cy, 8, bestV);
            nz.forEach((v, i) => { bestUvNz[i] = v; });
          }
        }
        copyPredToRecon(bestU, reconU, uvStride, cx, cy, 8);
        copyPredToRecon(bestV, reconV, uvStride, cx, cy, 8);
        for (let ch = 0; ch < 2; ch++) {
          tnzC[4 + 2 * ch] = bestUvNz[ch * 4];
          tnzC[5 + 2 * ch] = bestUvNz[ch * 4 + 1];
          costLeftNz[4 + 2 * ch] = bestUvNz[ch * 4 + 2];
          costLeftNz[5 + 2 * ch] = bestUvNz[ch * 4 + 3];
        }
      } // end RD path (effort: "quality")

      const mbY2 = yMode === I4 ? null : y2;
      let skip = mbY2 === null || mbY2.last < 0;
      if (skip) {
        for (const r of luma) if (r.last >= 0) { skip = false; break; }
      }
      if (skip) {
        for (const r of uv) if (r.last >= 0) { skip = false; break; }
      }
      if (skip) nbSkip++;
      mbs[mby * mbW + mbx] = { yMode, i4Modes, uvMode, skip, y2: mbY2, luma, uv };
    }
  }

  // skip probability (libwebp CalcSkipProba / SKIP_PROBA_THRESHOLD)
  const totalMbs = mbW * mbH;
  const skipProba = totalMbs ? (((totalMbs - nbSkip) * 255) / totalMbs) | 0 : 255;
  const useSkipProba = skipProba < 250;

  // ---- pass 1.5: record token stats, adapt coefficient probabilities ----
  // Mirrors the pass-2 token loop (including skip/context handling) so the
  // stats match what will actually be coded.
  const stats: TokenStats = new Uint32Array(4 * 8 * 3 * 11 * 2);
  {
    const topNzS: number[][] = Array.from({ length: mbW }, () => new Array(9).fill(0));
    for (let mby = 0; mby < mbH; mby++) {
      const leftNzS = new Array(9).fill(0);
      for (let mbx = 0; mbx < mbW; mbx++) {
        const mb = mbs[mby * mbW + mbx];
        const tnz = topNzS[mbx];
        if (useSkipProba && mb.skip) {
          // skip clears the luma/uv contexts; the y2 context carries over
          // for B_PRED macroblocks (decoder VP8DecodeMB)
          tnz.fill(0, 0, 8);
          leftNzS.fill(0, 0, 8);
          if (mb.y2) tnz[8] = leftNzS[8] = 0;
          continue;
        }
        if (mb.y2) {
          tnz[8] = leftNzS[8] = recordCoeffs(stats, tnz[8] + leftNzS[8], 1, 0, mb.y2);
        }
        const lumaType = mb.y2 ? 0 : 3;
        const lumaFirst = mb.y2 ? 1 : 0;
        for (let by = 0; by < 4; by++) {
          for (let bx = 0; bx < 4; bx++) {
            const ctx = tnz[bx] + leftNzS[by];
            const nz = recordCoeffs(stats, ctx, lumaType, lumaFirst, mb.luma[by * 4 + bx]);
            tnz[bx] = leftNzS[by] = nz;
          }
        }
        for (let ch = 0; ch <= 2; ch += 2) {
          for (let by = 0; by < 2; by++) {
            for (let bx = 0; bx < 2; bx++) {
              const ctx = tnz[4 + ch + bx] + leftNzS[4 + ch + by];
              const nz = recordCoeffs(stats, ctx, 2, 0, mb.uv[(ch >> 1) * 4 + by * 2 + bx]);
              tnz[4 + ch + bx] = leftNzS[4 + ch + by] = nz;
            }
          }
        }
      }
    }
  }
  const coeffProbs = finalizeTokenProbas(stats);

  // ---- pass 2: write partitions ----
  const headerBw = new BoolEncoder();
  const tokenBw = new BoolEncoder();

  // partition 0: frame header (order per libwebp GeneratePartition0)
  headerBw.putBitUniform(0); // color space
  headerBw.putBitUniform(0); // clamping type
  headerBw.putBitUniform(0); // no segmentation
  headerBw.putBitUniform(0); // filter type: normal
  headerBw.putBits(filterLevel, 6);
  headerBw.putBits(0, 3); // sharpness
  headerBw.putBitUniform(0); // no lf deltas
  headerBw.putBits(0, 2); // log2(token partitions) = 0 -> 1 partition
  headerBw.putBits(qi, 7); // base quantizer index
  headerBw.putSignedBits(0, 4); // y1 dc delta
  headerBw.putSignedBits(0, 4); // y2 dc delta
  headerBw.putSignedBits(0, 4); // y2 ac delta
  headerBw.putSignedBits(0, 4); // uv dc delta
  headerBw.putSignedBits(0, 4); // uv ac delta
  headerBw.putBitUniform(0); // refresh entropy probs
  // coefficient probability updates (adapted per-frame in pass 1.5)
  for (let t = 0; t < 4; t++) {
    for (let b = 0; b < 8; b++) {
      for (let c = 0; c < 3; c++) {
        for (let pIdx = 0; pIdx < 11; pIdx++) {
          const p0 = coeffProbs[t][b][c][pIdx];
          const update = p0 !== COEFFS_PROBA0[t][b][c][pIdx];
          if (headerBw.putBit(update, COEFFS_UPDATE_PROBA[t][b][c][pIdx])) {
            headerBw.putBits(p0, 8);
          }
        }
      }
    }
  }
  if (headerBw.putBitUniform(useSkipProba)) {
    headerBw.putBits(skipProba, 8);
  }

  // modes (partition 0), tokens (partition 1), nz context bookkeeping
  const probsY2 = coeffProbs[1];
  const probsYnoDC = coeffProbs[0];
  const probsUV = coeffProbs[2];
  const probsI4 = coeffProbs[3];
  const topNz: number[][] = Array.from({ length: mbW }, () => new Array(9).fill(0));
  const topBM = new Uint8Array(mbW * 4); // 4x4 mode-coding contexts, as in pass 1
  const leftBM = new Uint8Array(4);

  for (let mby = 0; mby < mbH; mby++) {
    const leftNz = new Array(9).fill(0);
    leftBM.fill(0);
    for (let mbx = 0; mbx < mbW; mbx++) {
      const mb = mbs[mby * mbW + mbx];

      if (useSkipProba) headerBw.putBit(mb.skip, skipProba);
      // keyframe luma mode tree: {B_PRED, {DC,V}, {H,TM}}, probs 145/156/163/128
      if (headerBw.putBit(mb.yMode !== I4, 145)) {
        if (headerBw.putBit(mb.yMode === TM || mb.yMode === H, 156)) {
          headerBw.putBit(mb.yMode === TM, 128);
        } else {
          headerBw.putBit(mb.yMode === V, 163);
        }
        const bm = I16_TO_BMODE[mb.yMode];
        topBM.fill(bm, mbx * 4, mbx * 4 + 4);
        leftBM.fill(bm);
      } else {
        const modes = mb.i4Modes!;
        for (let b = 0; b < 16; b++) {
          const bx = b & 3;
          const by = b >> 2;
          const above = by === 0 ? topBM[mbx * 4 + bx] : modes[b - 4];
          const left = bx === 0 ? leftBM[by] : modes[b - 1];
          putI4Mode(headerBw, modes[b], KB_MODES_PROBA[above][left]);
        }
        for (let i = 0; i < 4; i++) {
          topBM[mbx * 4 + i] = modes[12 + i];
          leftBM[i] = modes[i * 4 + 3];
        }
      }
      // chroma mode tree, probs 142/114/183
      if (headerBw.putBit(mb.uvMode !== DC, 142)) {
        if (headerBw.putBit(mb.uvMode !== V, 114)) {
          headerBw.putBit(mb.uvMode !== H, 183);
        }
      }

      const tnz = topNz[mbx];
      // The decoder only honors skip when use_skip_proba is on (RFC 6386
      // §11.1); without it, residuals are parsed for every MB.
      if (useSkipProba && mb.skip) {
        // decoder zeroes the luma/uv nz contexts on skip; the y2 context
        // carries over for B_PRED macroblocks (decoder VP8DecodeMB)
        tnz.fill(0, 0, 8);
        leftNz.fill(0, 0, 8);
        if (mb.y2) tnz[8] = leftNz[8] = 0;
        continue;
      }
      if (mb.y2) {
        const y2Nz = putCoeffs(tokenBw, tnz[8] + leftNz[8], probsY2, 0, mb.y2);
        tnz[8] = leftNz[8] = y2Nz;
      }
      const probsLuma = mb.y2 ? probsYnoDC : probsI4;
      const lumaFirst = mb.y2 ? 1 : 0;
      for (let by = 0; by < 4; by++) {
        for (let bx = 0; bx < 4; bx++) {
          const ctx = tnz[bx] + leftNz[by];
          const nz = putCoeffs(tokenBw, ctx, probsLuma, lumaFirst, mb.luma[by * 4 + bx]);
          tnz[bx] = leftNz[by] = nz;
        }
      }
      for (let ch = 0; ch <= 2; ch += 2) {
        for (let by = 0; by < 2; by++) {
          for (let bx = 0; bx < 2; bx++) {
            const ctx = tnz[4 + ch + bx] + leftNz[4 + ch + by];
            const res = mb.uv[(ch >> 1) * 4 + by * 2 + bx];
            const nz = putCoeffs(tokenBw, ctx, probsUV, 0, res);
            tnz[4 + ch + bx] = leftNz[4 + ch + by] = nz;
          }
        }
      }
    }
  }

  const part0 = headerBw.finish();
  const part1 = tokenBw.finish();
  // The frame tag stores the partition-0 size in 19 bits; anything larger
  // would be silently truncated into an undecodable file (libwebp errors
  // with VP8_ENC_ERROR_PARTITION0_OVERFLOW here). 4x4 modes are the only
  // per-MB header data that can realistically get there — drop them and
  // retry once before giving up (libwebp halves max_i4_header_bits_).
  if (part0.length >= 1 << 19) {
    if (allowI4) return encodeVP8Frame(yuv, opts, false);
    throw new RangeError(
      `VP8: partition 0 is ${part0.length} bytes, exceeding the bitstream's 2^19-1 limit — image too large/complex for a VP8 keyframe`,
    );
  }

  // uncompressed frame header (RFC 6386 §9.1): 10 bytes
  const tag = 0 /* keyframe */ | (0 << 1) /* version */ | (1 << 4) /* show */ |
    (part0.length << 5);
  const out = new Uint8Array(10 + part0.length + part1.length);
  out[0] = tag & 0xff;
  out[1] = (tag >>> 8) & 0xff;
  out[2] = (tag >>> 16) & 0xff;
  out[3] = 0x9d;
  out[4] = 0x01;
  out[5] = 0x2a;
  out[6] = yuv.width & 0xff;
  out[7] = (yuv.width >> 8) & 0x3f; // scale = 0
  out[8] = yuv.height & 0xff;
  out[9] = (yuv.height >> 8) & 0x3f;
  out.set(part0, 10);
  out.set(part1, 10 + part0.length);
  return out;
}
