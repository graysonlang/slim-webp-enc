// Mini-VP8L encoder for ALPH method 1: the (already filtered) alpha plane is
// coded as the green channel of a headerless VP8L stream (no signature, no
// size fields — dimensions come from the frame). Scope per PLAN.md: no VP8L
// transforms, no palette, no color cache, one Huffman group, greedy LZ77
// limited to distance 1 (run) and distance = width (row copy).
//
// Bitstream references: WebP Lossless Bitstream Specification;
// libwebp dec/vp8l_dec.c (DecodeImageStream) is the authoritative reader.

import { PLANE_TO_CODE } from "./tables.ts";

// --- LSB-first bit writer (VP8LBitWriter) ---

export class LsbBitWriter {
  private buf: number[] = [];
  private acc = 0; // bit accumulator
  private used = 0; // bits used in acc

  putBits(value: number, nBits: number): void {
    this.acc |= value << this.used;
    this.used += nBits;
    while (this.used >= 8) {
      this.buf.push(this.acc & 0xff);
      this.acc >>>= 8;
      this.used -= 8;
    }
  }

  finish(): Uint8Array {
    if (this.used > 0) {
      this.buf.push(this.acc & 0xff);
      this.acc = 0;
      this.used = 0;
    }
    return new Uint8Array(this.buf);
  }
}

// --- prefix (length/distance) encoding, VP8LPrefixEncode ---

interface PrefixCode {
  code: number;
  extraBits: number;
  extraValue: number;
}

export function prefixEncode(value: number): PrefixCode {
  if (value <= 4) return { code: value - 1, extraBits: 0, extraValue: 0 };
  const d = value - 1;
  const highestBit = 31 - Math.clz32(d);
  const secondHighestBit = (d >> (highestBit - 1)) & 1;
  const extraBits = highestBit - 1;
  return {
    code: 2 * highestBit + secondHighestBit,
    extraBits,
    extraValue: d & ((1 << extraBits) - 1),
  };
}

/** Map a linear distance to the VP8L 2D "plane code". */
export function distanceToPlaneCode(xsize: number, dist: number): number {
  const yoffset = (dist / xsize) | 0;
  const xoffset = dist - yoffset * xsize;
  if (xoffset <= 8 && yoffset < 8) {
    return PLANE_TO_CODE[yoffset * 16 + 8 - xoffset] + 1;
  } else if (xoffset > xsize - 8 && yoffset < 7) {
    return PLANE_TO_CODE[(yoffset + 1) * 16 + 8 + (xsize - xoffset)] + 1;
  }
  return dist + 120;
}

// --- canonical Huffman codes ---

interface HuffmanCode {
  /** code bits, already reversed for the LSB-first stream */
  codes: Uint16Array;
  lengths: Uint8Array;
}

/**
 * Build depth-limited canonical Huffman code lengths from symbol counts.
 * Standard two-queue Huffman; on depth overflow, halve counts and retry.
 */
export function buildCodeLengths(counts: Uint32Array, maxDepth: number): Uint8Array {
  const n = counts.length;
  const lengths = new Uint8Array(n);
  const used: number[] = [];
  for (let i = 0; i < n; i++) if (counts[i] > 0) used.push(i);
  if (used.length === 0) return lengths;
  if (used.length === 1) {
    lengths[used[0]] = 1;
    return lengths;
  }
  let scaled = Array.from(counts);
  for (;;) {
    // nodes: [count, symbol | -1, left, right]
    interface Node {
      count: number;
      symbol: number;
      left: Node | null;
      right: Node | null;
    }
    const heap: Node[] = used
      .map((s) => ({ count: scaled[s], symbol: s, left: null, right: null }))
      .sort((a, b) => a.count - b.count);
    // simple O(n^2) merge — alphabets are tiny (≤280)
    while (heap.length > 1) {
      const a = heap.shift()!;
      const b = heap.shift()!;
      const merged: Node = { count: a.count + b.count, symbol: -1, left: a, right: b };
      let lo = 0;
      let hi = heap.length;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (heap[mid].count <= merged.count) lo = mid + 1;
        else hi = mid;
      }
      heap.splice(lo, 0, merged);
    }
    let overflow = false;
    const assign = (node: Node, depth: number): void => {
      if (node.symbol >= 0) {
        if (depth > maxDepth) overflow = true;
        lengths[node.symbol] = depth;
        return;
      }
      assign(node.left!, depth + 1);
      assign(node.right!, depth + 1);
    };
    assign(heap[0], 0);
    if (!overflow) return lengths;
    scaled = scaled.map((c) => (c > 0 ? (c + 1) >> 1 : 0));
  }
}

function reverseBits(value: number, nBits: number): number {
  let r = 0;
  for (let i = 0; i < nBits; i++) {
    r = (r << 1) | ((value >> i) & 1);
  }
  return r;
}

/**
 * A Huffman tree with exactly one used symbol consumes ZERO bits per read on
 * the decoder side (the code length in the serialized tree is a marker, not
 * an emission length). Writing 1 bit per symbol for such trees desyncs the
 * stream — zero the emission lengths instead.
 */
function zeroSingleSymbolCode(code: HuffmanCode): HuffmanCode {
  let used = 0;
  for (const l of code.lengths) if (l > 0) used++;
  if (used !== 1) return code;
  return { codes: code.codes, lengths: new Uint8Array(code.lengths.length) };
}

/** Canonical code assignment (VP8LConvertBitDepthsToSymbols), pre-reversed. */
export function lengthsToCodes(lengths: Uint8Array): HuffmanCode {
  const maxLen = Math.max(0, ...lengths);
  const countPerLen = new Array(maxLen + 1).fill(0);
  for (const l of lengths) if (l > 0) countPerLen[l]++;
  const nextCode = new Array(maxLen + 1).fill(0);
  let code = 0;
  for (let l = 1; l <= maxLen; l++) {
    code = (code + countPerLen[l - 1]) << 1;
    nextCode[l] = code;
  }
  const codes = new Uint16Array(lengths.length);
  for (let s = 0; s < lengths.length; s++) {
    if (lengths[s] > 0) {
      codes[s] = reverseBits(nextCode[lengths[s]]++, lengths[s]);
    }
  }
  return { codes, lengths };
}

// --- Huffman code serialization (mirror of ReadHuffmanCode) ---

const CODE_LENGTH_CODE_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

/** Write one Huffman code to the stream. `lengths` covers the full alphabet. */
export function writeHuffmanCode(bw: LsbBitWriter, lengths: Uint8Array): void {
  const symbols: number[] = [];
  for (let s = 0; s < lengths.length; s++) if (lengths[s] > 0) symbols.push(s);

  if (symbols.length === 0) {
    // unused tree (e.g. distances when there are no matches): 1-symbol code
    bw.putBits(1, 1); // simple
    bw.putBits(0, 1); // num symbols - 1 = 0
    bw.putBits(0, 1); // first symbol is 1-bit coded
    bw.putBits(0, 1); // symbol 0
    return;
  }
  if (symbols.length <= 2 && symbols[symbols.length - 1] < 256) {
    bw.putBits(1, 1); // simple code
    bw.putBits(symbols.length - 1, 1);
    if (symbols[0] <= 1) {
      bw.putBits(0, 1); // first symbol fits in 1 bit
      bw.putBits(symbols[0], 1);
    } else {
      bw.putBits(1, 1);
      bw.putBits(symbols[0], 8);
    }
    if (symbols.length === 2) bw.putBits(symbols[1], 8);
    return;
  }

  // normal code: RLE-tokenize the length array (symbols 0..15, 16, 17, 18)
  bw.putBits(0, 1);
  interface Token {
    symbol: number;
    extra: number;
    extraBits: number;
  }
  const tokens: Token[] = [];
  let prevNonZeroLen = 8; // DEFAULT_CODE_LENGTH
  for (let i = 0; i < lengths.length; ) {
    const len = lengths[i];
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === len) run++;
    if (len === 0) {
      let left = run;
      while (left >= 11) {
        const r = Math.min(left, 138);
        tokens.push({ symbol: 18, extra: r - 11, extraBits: 7 });
        left -= r;
      }
      if (left >= 3) {
        tokens.push({ symbol: 17, extra: left - 3, extraBits: 3 });
        left = 0;
      }
      while (left-- > 0) tokens.push({ symbol: 0, extra: 0, extraBits: 0 });
    } else {
      let left = run;
      if (len !== prevNonZeroLen) {
        tokens.push({ symbol: len, extra: 0, extraBits: 0 });
        prevNonZeroLen = len;
        left--;
      }
      while (left >= 3) {
        const r = Math.min(left, 6);
        tokens.push({ symbol: 16, extra: r - 3, extraBits: 2 });
        left -= r;
      }
      while (left-- > 0) tokens.push({ symbol: len, extra: 0, extraBits: 0 });
    }
    i += run;
  }

  // code-length-code: canonical Huffman over the 19 token symbols, depth ≤ 7
  const clCounts = new Uint32Array(19);
  for (const t of tokens) clCounts[t.symbol]++;
  let clLengths = buildCodeLengths(clCounts, 7);
  // Decoders special-case a single-symbol table as 0-bit reads (libwebp
  // ClearHuffmanTreeIfOnlyOneSymbol applies to this code too), so zero the
  // emit lengths like the data trees below — writing 1 bit per token when
  // only one token symbol is used would desync the whole stream.
  const clCode = zeroSingleSymbolCode(lengthsToCodes(clLengths));

  let numCodes = CODE_LENGTH_CODE_ORDER.length;
  while (numCodes > 4 && clLengths[CODE_LENGTH_CODE_ORDER[numCodes - 1]] === 0) numCodes--;
  bw.putBits(numCodes - 4, 4);
  for (let i = 0; i < numCodes; i++) {
    bw.putBits(clLengths[CODE_LENGTH_CODE_ORDER[i]], 3);
  }
  bw.putBits(0, 1); // no max_symbol shortcut: code all entries

  for (const t of tokens) {
    bw.putBits(clCode.codes[t.symbol], clCode.lengths[t.symbol]);
    if (t.extraBits > 0) bw.putBits(t.extra, t.extraBits);
  }
}

// --- LZ77 over ARGB pixels ---

const MIN_MATCH = 4;
const MAX_MATCH = 4096;

type Op =
  | { literal: number } // ARGB pixel value
  | { length: number; distCode: number };

function findRefs(pixels: Uint32Array, width: number): Op[] {
  const ops: Op[] = [];
  const n = pixels.length;
  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    for (const dist of i >= width ? [1, width] : [1]) {
      if (i < dist) continue;
      let len = 0;
      const max = Math.min(MAX_MATCH, n - i);
      while (len < max && pixels[i + len] === pixels[i + len - dist]) len++;
      if (len > bestLen) {
        bestLen = len;
        bestDist = dist;
      }
    }
    if (bestLen >= MIN_MATCH) {
      ops.push({ length: bestLen, distCode: distanceToPlaneCode(width, bestDist) });
      i += bestLen;
    } else {
      ops.push({ literal: pixels[i] });
      i++;
    }
  }
  return ops;
}

// --- entropy-coded image stream (the part after the transform section) ---

const NUM_LITERALS = 256;
const NUM_LENGTH_CODES = 24;
const GREEN_ALPHABET = NUM_LITERALS + NUM_LENGTH_CODES; // no color cache

/**
 * Write one entropy-coded ARGB image: color-cache bit, meta-Huffman bit
 * (level-0 streams only, per DecodeImageStream), the five Huffman codes, and
 * the LZ77-coded pixels. The caller is responsible for the transform section.
 */
function writeImageStream(
  bw: LsbBitWriter,
  pixels: Uint32Array,
  width: number,
  level0: boolean,
): void {
  const ops = findRefs(pixels, width);

  const greenCounts = new Uint32Array(GREEN_ALPHABET);
  const redCounts = new Uint32Array(256);
  const blueCounts = new Uint32Array(256);
  const alphaCounts = new Uint32Array(256);
  const distCounts = new Uint32Array(40);
  for (const op of ops) {
    if ("literal" in op) {
      greenCounts[(op.literal >>> 8) & 0xff]++;
      redCounts[(op.literal >>> 16) & 0xff]++;
      blueCounts[op.literal & 0xff]++;
      alphaCounts[op.literal >>> 24]++;
    } else {
      greenCounts[NUM_LITERALS + prefixEncode(op.length).code]++;
      distCounts[prefixEncode(op.distCode).code]++;
    }
  }

  const greenLengths = buildCodeLengths(greenCounts, 15);
  const redLengths = buildCodeLengths(redCounts, 15);
  const blueLengths = buildCodeLengths(blueCounts, 15);
  const alphaLengths = buildCodeLengths(alphaCounts, 15);
  const distLengths = buildCodeLengths(distCounts, 15);
  // serialized trees keep the length-1 marker; emission uses 0-bit codes
  // when a tree has a single symbol
  const green = zeroSingleSymbolCode(lengthsToCodes(greenLengths));
  const red = zeroSingleSymbolCode(lengthsToCodes(redLengths));
  const blue = zeroSingleSymbolCode(lengthsToCodes(blueLengths));
  const alpha = zeroSingleSymbolCode(lengthsToCodes(alphaLengths));
  const dist = zeroSingleSymbolCode(lengthsToCodes(distLengths));

  bw.putBits(0, 1); // no color cache
  if (level0) bw.putBits(0, 1); // no meta-Huffman (single group)

  writeHuffmanCode(bw, greenLengths); // green + length codes
  writeHuffmanCode(bw, redLengths);
  writeHuffmanCode(bw, blueLengths);
  writeHuffmanCode(bw, alphaLengths);
  writeHuffmanCode(bw, distLengths);

  const emit = (code: HuffmanCode, sym: number): void => {
    if (code.lengths[sym] > 0) bw.putBits(code.codes[sym], code.lengths[sym]);
  };
  for (const op of ops) {
    if ("literal" in op) {
      emit(green, (op.literal >>> 8) & 0xff);
      emit(red, (op.literal >>> 16) & 0xff);
      emit(blue, op.literal & 0xff);
      emit(alpha, op.literal >>> 24);
    } else {
      const lp = prefixEncode(op.length);
      emit(green, NUM_LITERALS + lp.code);
      if (lp.extraBits > 0) bw.putBits(lp.extraValue, lp.extraBits);
      const dp = prefixEncode(op.distCode);
      emit(dist, dp.code);
      if (dp.extraBits > 0) bw.putBits(dp.extraValue, dp.extraBits);
    }
  }
}

/**
 * Encode a (filtered) alpha plane as a headerless VP8L stream — the payload
 * that follows the ALPH header byte for compression method 1. Alpha values
 * ride in the green channel; the other channels are constant.
 */
export function encodeAlphaVP8L(data: Uint8Array, width: number, height: number): Uint8Array {
  void height; // dimensions travel in the enclosing container
  const pixels = new Uint32Array(data.length);
  for (let i = 0; i < data.length; i++) pixels[i] = (0xff000000 | (data[i] << 8)) >>> 0;
  const bw = new LsbBitWriter();
  bw.putBits(0, 1); // no transforms
  writeImageStream(bw, pixels, width, true);
  return bw.finish();
}

// --- full lossless VP8L file payload (palette / color-indexing transform) ---

/** Spec-mandated pixel bundling: indices packed per coded pixel. */
export function paletteWidthBits(paletteSize: number): number {
  return paletteSize <= 2 ? 3 : paletteSize <= 4 ? 2 : paletteSize <= 16 ? 1 : 0;
}

/**
 * Encode interleaved RGBA as a complete "VP8L" chunk payload (lossless),
 * using the color-indexing (palette) transform. Returns null when the image
 * has more than 256 distinct colors — the caller should stick with lossy.
 */
export function encodeVP8L(
  rgba: Uint8Array | Uint8ClampedArray,
  width: number,
  height: number,
): Uint8Array | null {
  // collect distinct ARGB values
  const colorSet = new Set<number>();
  const n = width * height;
  const argb = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const px =
      ((rgba[i * 4 + 3] << 24) | (rgba[i * 4] << 16) | (rgba[i * 4 + 1] << 8) | rgba[i * 4 + 2]) >>>
      0;
    argb[i] = px;
    colorSet.add(px);
    if (colorSet.size > 256) return null;
  }
  const palette = [...colorSet].sort((a, b) => a - b);
  const index = new Map<number, number>();
  palette.forEach((px, i) => {
    index.set(px, i);
  });

  // bundle indices into the green channel of a narrower image
  const xbits = paletteWidthBits(palette.length);
  const bpp = 8 >> xbits;
  const packedW = (width + (1 << xbits) - 1) >> xbits;
  const packed = new Uint32Array(packedW * height);
  packed.fill(0xff000000);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = index.get(argb[y * width + x]) as number;
      const p = y * packedW + (x >> xbits);
      packed[p] = (packed[p] | (idx << (bpp * (x & ((1 << xbits) - 1)) + 8))) >>> 0;
    }
  }

  let alphaUsed = false;
  for (const px of palette) {
    if (px >>> 24 !== 255) {
      alphaUsed = true;
      break;
    }
  }

  const bw = new LsbBitWriter();
  // VP8L header: signature, dimensions-1 (14 bits each), alpha hint, version
  bw.putBits(0x2f, 8);
  bw.putBits(width - 1, 14);
  bw.putBits(height - 1, 14);
  bw.putBits(alphaUsed ? 1 : 0, 1);
  bw.putBits(0, 3);

  // color-indexing transform + delta-coded palette as a (size x 1) sub-image
  bw.putBits(1, 1); // transform present
  bw.putBits(3, 2); // COLOR_INDEXING_TRANSFORM
  bw.putBits(palette.length - 1, 8);
  const deltas = new Uint32Array(palette.length);
  let prev = 0;
  for (let i = 0; i < palette.length; i++) {
    const cur = palette[i];
    // component-wise subtraction mod 256 (inverse of VP8LAddPixels)
    deltas[i] =
      ((((cur >>> 24) - (prev >>> 24)) & 0xff) * 0x1000000 +
        ((((cur >>> 16) - (prev >>> 16)) & 0xff) << 16) +
        ((((cur >>> 8) - (prev >>> 8)) & 0xff) << 8) +
        ((cur - prev) & 0xff)) >>>
      0;
    prev = cur;
  }
  writeImageStream(bw, deltas, palette.length, false);
  bw.putBits(0, 1); // no more transforms

  writeImageStream(bw, packed, packedW, true);
  return bw.finish();
}
