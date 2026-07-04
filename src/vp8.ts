// Minimal VP8 intra-keyframe encoder: 16x16 luma modes (DC/V/H/TM) + chroma
// modes selected by SAD, single segment, flat quantization, default
// probability tables, one token partition, MB skip, loop-filter level from QP.
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
  ZIGZAG,
} from "./tables.ts";
import { fdct4x4, fwht4x4, idct4x4, iwht4x4 } from "./transform.ts";
import type { YuvImage } from "./yuv.ts";

export interface Vp8Options {
  /** Quantizer index 0..127 (lower = better quality). */
  qi: number;
  /** Loop-filter strength 0..100 (cwebp -f). Default 60. */
  filterStrength?: number;
}

const MAX_LEVEL = 2047;

// Prediction modes (numbering is local; bitstream bits are written explicitly)
const DC = 0;
const V = 1;
const H = 2;
const TM = 3;

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

function sad(
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
      s += d < 0 ? -d : d;
    }
  }
  return s;
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
  yMode: number;
  uvMode: number;
  skip: boolean;
  y2: Residual;
  luma: Residual[]; // 16, raster order
  uv: Residual[]; // 4 U then 4 V
}

/** Encode a padded YUV420 image as a VP8 keyframe ("VP8 " chunk payload). */
export function encodeVP8Frame(yuv: YuvImage, opts: Vp8Options): Uint8Array {
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

  // ---- pass 1: mode decision, transform/quantize, reconstruction ----
  const mbs: MbData[] = new Array(mbW * mbH);
  let nbSkip = 0;

  for (let mby = 0; mby < mbH; mby++) {
    for (let mbx = 0; mbx < mbW; mbx++) {
      const hasTop = mby > 0;
      const hasLeft = mbx > 0;
      const yx = mbx * 16;
      const yy = mby * 16;
      const cx = mbx * 8;
      const cy = mby * 8;

      // luma mode by SAD
      let yMode = DC;
      let bestSad = Infinity;
      for (let m = 0; m < 4; m++) {
        buildPrediction(m, reconY, yStride, yx, yy, 16, hasTop, hasLeft, pred16);
        const s = sad(yuv.y, yStride, yx, yy, 16, pred16);
        if (s < bestSad) {
          bestSad = s;
          yMode = m;
          best16.set(pred16);
        }
      }
      copyPredToRecon(best16, reconY, yStride, yx, yy, 16);

      // luma transform + quant
      const luma: Residual[] = new Array(16);
      for (let b = 0; b < 16; b++) {
        const bx = yx + (b & 3) * 4;
        const by = yy + (b >> 2) * 4;
        const off = by * yStride + bx;
        fdct4x4(yuv.y, off, reconY, off, yStride, coeffs);
        dcs[b] = coeffs[0];
        luma[b] = quantizeBlock(coeffs, lumaDq[b], 1, quants.y1);
      }
      fwht4x4(dcs, y2raw);
      const y2 = quantizeBlock(y2raw, y2dq, 0, quants.y2);
      iwht4x4(y2dq, dcs);
      for (let b = 0; b < 16; b++) {
        const bx = yx + (b & 3) * 4;
        const by = yy + (b >> 2) * 4;
        const off = by * yStride + bx;
        lumaDq[b][0] = dcs[b];
        idct4x4(lumaDq[b], reconY, off, yStride, reconY, off);
      }

      // chroma mode by joint SAD over U and V
      let uvMode = DC;
      let bestUvSad = Infinity;
      for (let m = 0; m < 4; m++) {
        buildPrediction(m, reconU, uvStride, cx, cy, 8, hasTop, hasLeft, predU);
        buildPrediction(m, reconV, uvStride, cx, cy, 8, hasTop, hasLeft, predV);
        const s = sad(yuv.u, uvStride, cx, cy, 8, predU) + sad(yuv.v, uvStride, cx, cy, 8, predV);
        if (s < bestUvSad) {
          bestUvSad = s;
          uvMode = m;
          bestU.set(predU);
          bestV.set(predV);
        }
      }
      copyPredToRecon(bestU, reconU, uvStride, cx, cy, 8);
      copyPredToRecon(bestV, reconV, uvStride, cx, cy, 8);

      const uv: Residual[] = new Array(8);
      for (let ch = 0; ch < 2; ch++) {
        const src = ch === 0 ? yuv.u : yuv.v;
        const recon = ch === 0 ? reconU : reconV;
        for (let b = 0; b < 4; b++) {
          const bx = cx + (b & 1) * 4;
          const by = cy + (b >> 1) * 4;
          const off = by * uvStride + bx;
          fdct4x4(src, off, recon, off, uvStride, coeffs);
          uv[ch * 4 + b] = quantizeBlock(coeffs, uvDq, 0, quants.uv);
          idct4x4(uvDq, recon, off, uvStride, recon, off);
        }
      }

      let skip = y2.last < 0;
      if (skip) {
        for (const r of luma) if (r.last >= 0) { skip = false; break; }
      }
      if (skip) {
        for (const r of uv) if (r.last >= 0) { skip = false; break; }
      }
      if (skip) nbSkip++;
      mbs[mby * mbW + mbx] = { yMode, uvMode, skip, y2, luma, uv };
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
          tnz.fill(0);
          leftNzS.fill(0);
          continue;
        }
        tnz[8] = leftNzS[8] = recordCoeffs(stats, tnz[8] + leftNzS[8], 1, 0, mb.y2);
        for (let by = 0; by < 4; by++) {
          for (let bx = 0; bx < 4; bx++) {
            const ctx = tnz[bx] + leftNzS[by];
            const nz = recordCoeffs(stats, ctx, 0, 1, mb.luma[by * 4 + bx]);
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
  const topNz: number[][] = Array.from({ length: mbW }, () => new Array(9).fill(0));

  for (let mby = 0; mby < mbH; mby++) {
    const leftNz = new Array(9).fill(0);
    for (let mbx = 0; mbx < mbW; mbx++) {
      const mb = mbs[mby * mbW + mbx];

      if (useSkipProba) headerBw.putBit(mb.skip, skipProba);
      // keyframe luma mode tree: {B_PRED, {DC,V}, {H,TM}}, probs 145/156/163/128
      headerBw.putBit(1, 145); // i16x16, not B_PRED
      if (headerBw.putBit(mb.yMode === TM || mb.yMode === H, 156)) {
        headerBw.putBit(mb.yMode === TM, 128);
      } else {
        headerBw.putBit(mb.yMode === V, 163);
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
        // decoder zeroes all nz contexts on skip; coding all-zero blocks
        // would produce the same contexts, so just clear them
        tnz.fill(0);
        leftNz.fill(0);
        continue;
      }
      const y2Nz = putCoeffs(tokenBw, tnz[8] + leftNz[8], probsY2, 0, mb.y2);
      tnz[8] = leftNz[8] = y2Nz;
      for (let by = 0; by < 4; by++) {
        for (let bx = 0; bx < 4; bx++) {
          const ctx = tnz[bx] + leftNz[by];
          const nz = putCoeffs(tokenBw, ctx, probsYnoDC, 1, mb.luma[by * 4 + bx]);
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
  // with VP8_ENC_ERROR_PARTITION0_OVERFLOW here).
  if (part0.length >= 1 << 19) {
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
