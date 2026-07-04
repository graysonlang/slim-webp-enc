// Reference decoder for the headerless VP8L alpha stream produced by
// src/vp8l.ts, following the WebP Lossless Bitstream Specification and
// libwebp dec/vp8l_dec.c strictly. Round-trips the encoder over random and
// adversarial planes; on mismatch it reports where the stream diverges.
//
//   node harness/vp8ltest.ts

import { encodeAlphaVP8L, encodeVP8L, LsbBitWriter, writeHuffmanCode } from "../src/vp8l.ts";
import { PLANE_TO_CODE } from "../src/tables.ts";
import { mulberry32 } from "./content.ts";

class LsbBitReader {
  private pos = 0;
  private bit = 0;
  private readonly buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
  }
  readBits(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) {
      if (this.pos >= this.buf.length) throw new Error(`read past end at bit ${this.bitOffset()}`);
      v |= ((this.buf[this.pos] >> this.bit) & 1) << i;
      if (++this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    return v;
  }
  bitOffset(): number {
    return this.pos * 8 + this.bit;
  }
}

/** Canonical Huffman decoder from code lengths (slow bit-by-bit walk). */
class HuffmanTree {
  private codeToSym = new Map<string, number>();
  private maxLen = 0;
  private single = -1;
  constructor(lengths: number[]) {
    const used = lengths.map((l, s) => [l, s]).filter(([l]) => l > 0);
    if (used.length === 0) throw new Error("empty huffman tree");
    if (used.length === 1) {
      this.single = used[0][1];
      return;
    }
    // canonical assignment: sort by (length, symbol)
    const maxLen = Math.max(...lengths);
    let code = 0;
    for (let len = 1; len <= maxLen; len++) {
      for (let s = 0; s < lengths.length; s++) {
        if (lengths[s] !== len) continue;
        this.codeToSym.set(`${len}:${code}`, s);
        code++;
      }
      code <<= 1;
    }
    this.maxLen = maxLen;
    // completeness check (kraft sum == 1)
    const kraft = lengths.reduce((k, l) => (l > 0 ? k + 2 ** -l : k), 0);
    if (Math.abs(kraft - 1) > 1e-9) throw new Error(`incomplete huffman code (kraft=${kraft})`);
  }
  read(br: LsbBitReader): number {
    if (this.single >= 0) return this.single;
    let code = 0;
    for (let len = 1; len <= this.maxLen; len++) {
      code = (code << 1) | br.readBits(1);
      const sym = this.codeToSym.get(`${len}:${code}`);
      if (sym !== undefined) return sym;
    }
    throw new Error(`bad huffman code at bit ${br.bitOffset()}`);
  }
}

const CODE_LENGTH_CODE_ORDER = [17, 18, 0, 1, 2, 3, 4, 5, 16, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];

function readHuffmanCode(br: LsbBitReader, alphabetSize: number): HuffmanTree {
  const simple = br.readBits(1);
  const lengths = new Array(alphabetSize).fill(0);
  if (simple) {
    const numSymbols = br.readBits(1) + 1;
    const first8 = br.readBits(1);
    const sym0 = br.readBits(first8 ? 8 : 1);
    lengths[sym0] = 1;
    if (numSymbols === 2) {
      const sym1 = br.readBits(8);
      lengths[sym1] = 1;
    }
    if (numSymbols === 1) return new HuffmanTree(lengths); // 0-bit tree
    return new HuffmanTree(lengths);
  }
  // code-length code
  const numCodes = br.readBits(4) + 4;
  const clLengths = new Array(19).fill(0);
  for (let i = 0; i < numCodes; i++) {
    clLengths[CODE_LENGTH_CODE_ORDER[i]] = br.readBits(3);
  }
  const clTree = new HuffmanTree(clLengths);
  let maxSymbol: number;
  if (br.readBits(1)) {
    const lengthNBits = 2 + 2 * br.readBits(3);
    maxSymbol = 2 + br.readBits(lengthNBits);
    if (maxSymbol > alphabetSize) throw new Error("max_symbol > alphabet");
  } else {
    maxSymbol = alphabetSize;
  }
  let symbol = 0;
  let prevLen = 8;
  while (symbol < alphabetSize) {
    if (maxSymbol-- === 0) break;
    const codeLen = clTree.read(br);
    if (codeLen < 16) {
      lengths[symbol++] = codeLen;
      if (codeLen !== 0) prevLen = codeLen;
    } else if (codeLen === 16) {
      const repeat = br.readBits(2) + 3;
      for (let i = 0; i < repeat; i++) lengths[symbol++] = prevLen;
    } else if (codeLen === 17) {
      const repeat = br.readBits(3) + 3;
      symbol += repeat;
    } else {
      const repeat = br.readBits(7) + 11;
      symbol += repeat;
    }
    if (symbol > alphabetSize) throw new Error("code lengths overflow alphabet");
  }
  return new HuffmanTree(lengths);
}

function planeCodeToDistance(xsize: number, planeCode: number): number {
  if (planeCode > 120) return planeCode - 120;
  const v = PLANE_TO_CODE.indexOf(planeCode - 1);
  if (v < 0) throw new Error(`plane code ${planeCode} not in LUT`);
  const yoffset = v >> 4;
  const xoffset = 8 - (v & 15);
  const dist = yoffset * xsize + xoffset;
  return dist >= 1 ? dist : 1;
}

function prefixDecode(br: LsbBitReader, code: number): number {
  if (code < 4) return code + 1;
  const extraBits = (code - 2) >> 1;
  const offset = (2 + (code & 1)) << extraBits;
  return offset + br.readBits(extraBits) + 1;
}

/** One entropy-coded ARGB image (the part after the transform section). */
function readImageStream(
  br: LsbBitReader,
  width: number,
  height: number,
  level0: boolean,
): Uint32Array {
  if (br.readBits(1) !== 0) throw new Error("unexpected color cache");
  if (level0 && br.readBits(1) !== 0) throw new Error("unexpected meta-huffman");
  const green = readHuffmanCode(br, 256 + 24);
  const red = readHuffmanCode(br, 256);
  const blue = readHuffmanCode(br, 256);
  const alpha = readHuffmanCode(br, 256);
  const dist = readHuffmanCode(br, 40);

  const out = new Uint32Array(width * height);
  let i = 0;
  while (i < out.length) {
    const g = green.read(br);
    if (g < 256) {
      const r = red.read(br);
      const b = blue.read(br);
      const a = alpha.read(br);
      out[i++] = ((a << 24) | (r << 16) | (g << 8) | b) >>> 0;
    } else {
      const length = prefixDecode(br, g - 256);
      const distCode = prefixDecode(br, dist.read(br));
      const d = planeCodeToDistance(width, distCode);
      if (d > i) throw new Error(`distance ${d} reaches before start at px ${i}`);
      for (let k = 0; k < length; k++, i++) {
        if (i >= out.length) throw new Error("copy past end");
        out[i] = out[i - d];
      }
    }
  }
  return out;
}

function checkTrailing(stream: Uint8Array, br: LsbBitReader): void {
  // only byte-alignment padding may remain; a full trailing byte means the
  // encoder wrote bits the decoder never consumed (e.g. 1-bit codes for a
  // single-symbol tree)
  const remaining = stream.length * 8 - br.bitOffset();
  if (remaining >= 8) throw new Error(`${remaining} unconsumed trailing bits`);
}

/** Decode a headerless VP8L alpha stream back into the plane. */
export function decodeAlphaVP8L(stream: Uint8Array, width: number, height: number): Uint8Array {
  const br = new LsbBitReader(stream);
  if (br.readBits(1) !== 0) throw new Error("unexpected transform");
  const pixels = readImageStream(br, width, height, true);
  checkTrailing(stream, br);
  const out = new Uint8Array(pixels.length);
  for (let i = 0; i < pixels.length; i++) out[i] = (pixels[i] >>> 8) & 0xff;
  return out;
}

/** Decode a full "VP8L" chunk payload (header + color-indexing) to RGBA. */
export function decodeVP8LFile(stream: Uint8Array): {
  width: number;
  height: number;
  rgba: Uint8Array;
} {
  const br = new LsbBitReader(stream);
  if (br.readBits(8) !== 0x2f) throw new Error("bad VP8L signature");
  const width = br.readBits(14) + 1;
  const height = br.readBits(14) + 1;
  br.readBits(1); // alpha hint
  if (br.readBits(3) !== 0) throw new Error("bad VP8L version");

  let palette: Uint32Array | null = null;
  while (br.readBits(1)) {
    const type = br.readBits(2);
    if (type !== 3) throw new Error(`unsupported transform type ${type}`);
    if (palette) throw new Error("duplicate color-indexing transform");
    const size = br.readBits(8) + 1;
    const deltas = readImageStream(br, size, 1, false);
    palette = new Uint32Array(size);
    let prev = 0;
    for (let i = 0; i < size; i++) {
      const d = deltas[i];
      // component-wise addition mod 256 (VP8LAddPixels)
      prev =
        ((((prev >>> 24) + (d >>> 24)) & 0xff) * 0x1000000 +
          ((((prev >>> 16) + (d >>> 16)) & 0xff) << 16) +
          ((((prev >>> 8) + (d >>> 8)) & 0xff) << 8) +
          ((prev + d) & 0xff)) >>>
        0;
      palette[i] = prev;
    }
  }
  if (!palette) throw new Error("expected a color-indexing transform");

  const xbits = palette.length <= 2 ? 3 : palette.length <= 4 ? 2 : palette.length <= 16 ? 1 : 0;
  const bpp = 8 >> xbits;
  const packedW = (width + (1 << xbits) - 1) >> xbits;
  const packed = readImageStream(br, packedW, height, true);
  checkTrailing(stream, br);

  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const g = (packed[y * packedW + (x >> xbits)] >>> 8) & 0xff;
      const idx = (g >> (bpp * (x & ((1 << xbits) - 1)))) & ((1 << bpp) - 1);
      if (idx >= palette.length) throw new Error(`index ${idx} out of palette`);
      const px = palette[idx];
      const o = (y * width + x) * 4;
      rgba[o] = (px >>> 16) & 0xff;
      rgba[o + 1] = (px >>> 8) & 0xff;
      rgba[o + 2] = px & 0xff;
      rgba[o + 3] = px >>> 24;
    }
  }
  return { width, height, rgba };
}

// ---- round-trip tests (run directly: node harness/vp8ltest.ts) ----

interface Case {
  name: string;
  width: number;
  height: number;
  data: Uint8Array;
}

const cases: Case[] = [];

// the failing shape: vertical-filtered horizontal 16-level ramp
{
  const w = 256;
  const h = 128;
  const plane = new Uint8Array(w * h);
  for (let x = 0; x < w; x++) plane[x] = Math.round(Math.round((x / (w - 1)) * 15) * 17);
  // rows 1.. are zero (residual of a y-constant image under the vertical filter)
  cases.push({ name: "ramp-vfiltered", width: w, height: h, data: plane });
}
// constant plane
cases.push({ name: "constant", width: 64, height: 64, data: new Uint8Array(64 * 64).fill(128) });
// two-value plane
{
  const d = new Uint8Array(96 * 96);
  for (let i = 0; i < d.length; i++) d[i] = i % 96 < 48 ? 0 : 255;
  cases.push({ name: "two-values", width: 96, height: 96, data: d });
}
// random planes with varying alphabet sizes
for (const [seed, vals, w, h] of [[1, 2, 33, 17], [2, 5, 128, 64], [3, 16, 100, 75], [4, 256, 64, 64]] as const) {
  const rng = mulberry32(seed);
  const d = new Uint8Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = Math.floor(rng() * vals) * Math.floor(255 / (vals - 1 || 1));
  cases.push({ name: `random-${vals}vals-${w}x${h}`, width: w, height: h, data: d });
}
// regression: single-symbol distance tree (all matches are distance-1 runs)
// with more tokens after the first match — a 1-bit-per-distance emission
// desyncs everything that follows. This is the vertical-filtered alpha ramp.
{
  const w = 256;
  const h = 128;
  const d = new Uint8Array(w * h);
  for (let x = 9; x < w; x += 17) d[x] = 17; // row 0: sparse +17 spikes
  cases.push({ name: "single-dist-symbol", width: w, height: h, data: d });
}
// runs (RLE-friendly, like real filtered masks)
{
  const rng = mulberry32(99);
  const d = new Uint8Array(256 * 64);
  let i = 0;
  while (i < d.length) {
    const run = 1 + Math.floor(rng() * 200);
    const v = Math.floor(rng() * 16) * 17;
    for (let k = 0; k < run && i < d.length; k++) d[i++] = v;
  }
  cases.push({ name: "runs", width: 256, height: 64, data: d });
}

// full-file lossless (palette) round-trip cases: [name, width, height, colors]
const LOSSLESS_CASES: Array<[string, number, number, number]> = [
  ["ll-2colors", 100, 75, 2], // 1-bit bundling (8 px per coded pixel)
  ["ll-3colors", 96, 96, 3], // 2-bit bundling
  ["ll-4colors", 64, 64, 4],
  ["ll-13colors", 128, 128, 13], // 4-bit bundling
  ["ll-16colors", 33, 17, 16],
  ["ll-40colors", 100, 100, 40], // no bundling
  ["ll-256colors", 64, 64, 256],
  ["ll-1color", 50, 30, 1], // solid image
  ["ll-alpha", 96, 96, 5], // translucent palette entries
];

function makeLosslessCase(name: string, w: number, h: number, colors: number): Uint8Array {
  const rng = mulberry32(w * 31 + h * 7 + colors);
  const palette: number[] = [];
  for (let c = 0; c < colors; c++) {
    const alpha = name === "ll-alpha" && c % 2 === 0 ? Math.floor(rng() * 256) : 255;
    palette.push(
      ((alpha << 24) | (Math.floor(rng() * 256) << 16) | (Math.floor(rng() * 256) << 8) |
        Math.floor(rng() * 256)) >>> 0,
    );
  }
  const rgba = new Uint8Array(w * h * 4);
  let i = 0;
  while (i < w * h) {
    // mix of runs and speckle, like real flat graphics
    const run = rng() < 0.5 ? 1 : 1 + Math.floor(rng() * 60);
    const px = palette[Math.floor(rng() * colors)];
    for (let k = 0; k < run && i < w * h; k++, i++) {
      rgba[i * 4] = (px >>> 16) & 0xff;
      rgba[i * 4 + 1] = (px >>> 8) & 0xff;
      rgba[i * 4 + 2] = px & 0xff;
      rgba[i * 4 + 3] = px >>> 24;
    }
  }
  return rgba;
}

let failures = 0;
if (process.argv[1] === import.meta.filename) {
for (const c of cases) {
  try {
    const stream = encodeAlphaVP8L(c.data, c.width, c.height);
    const decoded = decodeAlphaVP8L(stream, c.width, c.height);
    let diff = -1;
    for (let i = 0; i < c.data.length; i++) {
      if (decoded[i] !== c.data[i]) {
        diff = i;
        break;
      }
    }
    if (diff >= 0) {
      failures++;
      console.log(`${c.name.padEnd(24)} FAIL: first mismatch at px ${diff} (got ${decoded[diff]}, want ${c.data[diff]})`);
    } else {
      console.log(`${c.name.padEnd(24)} ok (${stream.length} bytes)`);
    }
  } catch (e) {
    failures++;
    console.log(`${c.name.padEnd(24)} FAIL: ${(e as Error).message}`);
  }
}

for (const [name, w, h, colors] of LOSSLESS_CASES) {
  try {
    const rgba = makeLosslessCase(name, w, h, colors);
    const payload = encodeVP8L(rgba, w, h);
    if (!payload) throw new Error("encodeVP8L returned null");
    const dec = decodeVP8LFile(payload);
    if (dec.width !== w || dec.height !== h) throw new Error("dimension mismatch");
    let diff = -1;
    for (let i = 0; i < rgba.length; i++) {
      if (dec.rgba[i] !== rgba[i]) {
        diff = i;
        break;
      }
    }
    if (diff >= 0) {
      failures++;
      console.log(`${name.padEnd(24)} FAIL: first mismatch at byte ${diff}`);
    } else {
      console.log(`${name.padEnd(24)} ok (${payload.length} bytes)`);
    }
  } catch (e) {
    failures++;
    console.log(`${name.padEnd(24)} FAIL: ${(e as Error).message}`);
  }
}

// Regression: a uniform all-length-8 code over a 256-symbol alphabet
// tokenizes to symbol-16 repeats only, so the code-length code has a single
// used symbol. The writer must emit it as a 0-bit code (decoders special-case
// single-symbol tables as 0-bit reads); a 1-bit code desyncs the stream.
{
  const name = "single-symbol CL code";
  try {
    const lengths = new Uint8Array(256).fill(8);
    const bw = new LsbBitWriter();
    writeHuffmanCode(bw, lengths);
    bw.putBits(0x2d, 6); // sentinel: only readable if reader and writer agree
    const br = new LsbBitReader(bw.finish());
    readHuffmanCode(br, 256); // throws on incomplete/invalid decoded lengths
    const sentinel = br.readBits(6);
    if (sentinel !== 0x2d) throw new Error(`stream desync: sentinel 0x${sentinel.toString(16)}`);
    console.log(`${name.padEnd(24)} ok`);
  } catch (e) {
    failures++;
    console.log(`${name.padEnd(24)} FAIL: ${(e as Error).message}`);
  }
}

console.log(failures ? `\n${failures} FAILURES` : "\nall vp8l round-trips ok");
process.exit(failures ? 1 : 0);
}
