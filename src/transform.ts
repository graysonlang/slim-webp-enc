// VP8 4x4 transforms, ported from libwebp dsp/enc.c (forward) and dsp/dec.c
// (inverse WHT). The inverse DCT must be bit-exact with RFC 6386 §14.4 since
// the encoder reconstructs frames exactly as a decoder will.

const C1 = 20091; // WEBP_TRANSFORM_AC3_C1
const C2 = 35468; // WEBP_TRANSFORM_AC3_C2

function mul1(a: number): number {
  return (((a * C1) >> 16) + a) | 0;
}

function mul2(a: number): number {
  return ((a * C2) >> 16) | 0;
}

function clip8(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

// Shared scratch for the four leaf transforms below (none calls another).
// Hoisted because these run ~50 times per macroblock — a per-call allocation
// here is pure GC churn in the encoder's hottest loop.
const tmp = new Int32Array(16);

/**
 * Forward DCT of (src - ref) for one 4x4 block.
 * src/ref are sampled at (x + y*stride); out receives 16 coefficients.
 */
export function fdct4x4(
  src: Uint8Array,
  srcOff: number,
  ref: Uint8Array,
  refOff: number,
  stride: number,
  out: Int16Array,
): void {
  for (let i = 0; i < 4; i++) {
    const s = srcOff + i * stride;
    const r = refOff + i * stride;
    const d0 = src[s] - ref[r];
    const d1 = src[s + 1] - ref[r + 1];
    const d2 = src[s + 2] - ref[r + 2];
    const d3 = src[s + 3] - ref[r + 3];
    const a0 = d0 + d3;
    const a1 = d1 + d2;
    const a2 = d1 - d2;
    const a3 = d0 - d3;
    tmp[0 + i * 4] = (a0 + a1) * 8;
    tmp[1 + i * 4] = (a2 * 2217 + a3 * 5352 + 1812) >> 9;
    tmp[2 + i * 4] = (a0 - a1) * 8;
    tmp[3 + i * 4] = (a3 * 2217 - a2 * 5352 + 937) >> 9;
  }
  for (let i = 0; i < 4; i++) {
    const a0 = tmp[0 + i] + tmp[12 + i];
    const a1 = tmp[4 + i] + tmp[8 + i];
    const a2 = tmp[4 + i] - tmp[8 + i];
    const a3 = tmp[0 + i] - tmp[12 + i];
    out[0 + i] = (a0 + a1 + 7) >> 4;
    out[4 + i] = ((a2 * 2217 + a3 * 5352 + 12000) >> 16) + (a3 !== 0 ? 1 : 0);
    out[8 + i] = (a0 - a1 + 7) >> 4;
    out[12 + i] = (a3 * 2217 - a2 * 5352 + 51000) >> 16;
  }
}

/**
 * Inverse DCT: dst = clip(ref + idct(coeffs)) for one 4x4 block.
 * dst may alias ref (in-place reconstruction over the prediction).
 */
export function idct4x4(
  coeffs: Int16Array,
  ref: Uint8Array,
  refOff: number,
  stride: number,
  dst: Uint8Array,
  dstOff: number,
): void {
  for (let i = 0; i < 4; i++) {
    // vertical pass, input column i
    const a = coeffs[i] + coeffs[8 + i];
    const b = coeffs[i] - coeffs[8 + i];
    const c = mul2(coeffs[4 + i]) - mul1(coeffs[12 + i]);
    const d = mul1(coeffs[4 + i]) + mul2(coeffs[12 + i]);
    tmp[i * 4 + 0] = a + d;
    tmp[i * 4 + 1] = b + c;
    tmp[i * 4 + 2] = b - c;
    tmp[i * 4 + 3] = a - d;
  }
  for (let i = 0; i < 4; i++) {
    // horizontal pass, output row i
    const dc = tmp[0 + i] + 4;
    const a = dc + tmp[8 + i];
    const b = dc - tmp[8 + i];
    const c = mul2(tmp[4 + i]) - mul1(tmp[12 + i]);
    const d = mul1(tmp[4 + i]) + mul2(tmp[12 + i]);
    const o = dstOff + i * stride;
    const r = refOff + i * stride;
    dst[o] = clip8(ref[r] + ((a + d) >> 3));
    dst[o + 1] = clip8(ref[r + 1] + ((b + c) >> 3));
    dst[o + 2] = clip8(ref[r + 2] + ((b - c) >> 3));
    dst[o + 3] = clip8(ref[r + 3] + ((a - d) >> 3));
  }
}

/**
 * Forward Walsh-Hadamard transform over the 16 luma-block DC values.
 * `dcs` holds the DC of luma block k at index k (raster order within the MB).
 */
export function fwht4x4(dcs: Int16Array, out: Int16Array): void {
  for (let i = 0; i < 4; i++) {
    const i0 = i * 4; // row of luma blocks
    const a0 = dcs[i0] + dcs[i0 + 2];
    const a1 = dcs[i0 + 1] + dcs[i0 + 3];
    const a2 = dcs[i0 + 1] - dcs[i0 + 3];
    const a3 = dcs[i0] - dcs[i0 + 2];
    tmp[0 + i * 4] = a0 + a1;
    tmp[1 + i * 4] = a3 + a2;
    tmp[2 + i * 4] = a3 - a2;
    tmp[3 + i * 4] = a0 - a1;
  }
  for (let i = 0; i < 4; i++) {
    const a0 = tmp[0 + i] + tmp[8 + i];
    const a1 = tmp[4 + i] + tmp[12 + i];
    const a2 = tmp[4 + i] - tmp[12 + i];
    const a3 = tmp[0 + i] - tmp[8 + i];
    const b0 = a0 + a1;
    const b1 = a3 + a2;
    const b2 = a3 - a2;
    const b3 = a0 - a1;
    out[0 + i] = b0 >> 1;
    out[4 + i] = b1 >> 1;
    out[8 + i] = b2 >> 1;
    out[12 + i] = b3 >> 1;
  }
}

/**
 * Inverse WHT (RFC 6386 §14.3): dequantized Y2 block (block order) → the 16
 * luma-block DC values, raster order.
 */
export function iwht4x4(coeffs: Int16Array, dcs: Int16Array): void {
  for (let i = 0; i < 4; i++) {
    const a0 = coeffs[0 + i] + coeffs[12 + i];
    const a1 = coeffs[4 + i] + coeffs[8 + i];
    const a2 = coeffs[4 + i] - coeffs[8 + i];
    const a3 = coeffs[0 + i] - coeffs[12 + i];
    tmp[0 + i] = a0 + a1;
    tmp[8 + i] = a0 - a1;
    tmp[4 + i] = a3 + a2;
    tmp[12 + i] = a3 - a2;
  }
  for (let i = 0; i < 4; i++) {
    const dc = tmp[0 + i * 4] + 3;
    const a0 = dc + tmp[3 + i * 4];
    const a1 = tmp[1 + i * 4] + tmp[2 + i * 4];
    const a2 = tmp[1 + i * 4] - tmp[2 + i * 4];
    const a3 = dc - tmp[3 + i * 4];
    dcs[i * 4 + 0] = (a0 + a1) >> 3;
    dcs[i * 4 + 1] = (a3 + a2) >> 3;
    dcs[i * 4 + 2] = (a0 - a1) >> 3;
    dcs[i * 4 + 3] = (a3 - a2) >> 3;
  }
}
