// Probe: parse a VP8 keyframe's partition 0 and dump everything the encoder
// decided — segmentation (incl. per-segment quantizer deltas), filter level,
// quant indices (base + the 5 deltas), how many coefficient probabilities
// were updated, skip probability, and per-macroblock modes (segment, skip,
// i16/B_PRED luma mode incl. sub-modes, chroma mode).
//
// This is the ground truth for "what does libwebp actually signal that slim
// doesn't": run it on both encoders' output for the same input.
//
//   node harness/vp8hdr.ts file.webp [file2.webp ...]
//
// Parsing mirrors libwebp's dec/tree_dec.c ParseIntraMode (hardcoded trees,
// libwebp mode numbering: i16 DC=0 TM=1 V=2 H=3 so i16 modes coincide with
// B_DC/B_TM/B_VE/B_HE as sub-mode contexts).

import { readFile } from "node:fs/promises";
import { extractChunk } from "../src/container.ts";
import { AC_TABLE, COEFFS_UPDATE_PROBA, DC_TABLE } from "../src/tables.ts";
import { KB_MODES_PROBA } from "./kbmodes-proba.ts";

// ---------------------------------------------------------------------------
// Boolean decoder (RFC 6386 §7.2)

class BoolDecoder {
  private range = 255;
  private value = 0;
  private bitCount = 0;
  private pos: number;
  private buf: Uint8Array;

  constructor(buf: Uint8Array, start: number) {
    this.buf = buf;
    this.pos = start;
    this.value = (this.byte() << 8) | this.byte();
  }

  private byte(): number {
    return this.pos < this.buf.length ? this.buf[this.pos++] : 0;
  }

  getBit(prob: number): number {
    const split = 1 + (((this.range - 1) * prob) >> 8);
    const SPLIT = split << 8;
    let ret: number;
    if (this.value >= SPLIT) {
      ret = 1;
      this.range -= split;
      this.value -= SPLIT;
    } else {
      ret = 0;
      this.range = split;
    }
    while (this.range < 128) {
      this.value <<= 1;
      this.range <<= 1;
      if (++this.bitCount === 8) {
        this.bitCount = 0;
        this.value |= this.byte();
        this.value &= 0xffffff;
      }
    }
    return ret;
  }

  /** n-bit literal, MSB first, probability 128 each. */
  getValue(n: number): number {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v << 1) | this.getBit(128);
    return v;
  }

  /** n-bit magnitude + sign bit (VP8GetSignedValue). */
  getSigned(n: number): number {
    const v = this.getValue(n);
    return this.getBit(128) ? -v : v;
  }

  /** flag ? signed(n) : 0 — the "flagged delta" pattern of the frame header. */
  getFlaggedSigned(n: number): number {
    return this.getBit(128) ? this.getSigned(n) : 0;
  }
}

// ---------------------------------------------------------------------------

const I16_NAMES = ["DC", "TM", "V", "H"]; // libwebp numbering
const B_NAMES = ["B_DC", "B_TM", "B_VE", "B_HE", "B_RD", "B_VR", "B_LD", "B_VL", "B_HD", "B_HU"];
const UV_NAMES = ["DC", "V", "H", "TM"]; // our numbering below

export interface MbInfo {
  segment: number;
  skip: boolean | null; // null when use_skip_proba is off
  isI4: boolean;
  yMode: string; // "DC"/"TM"/"V"/"H" or "B_PRED"
  subModes?: string[]; // 16 entries when isI4
  uvMode: string;
}

export interface Vp8Header {
  width: number;
  height: number;
  part0Size: number;
  useSegment: boolean;
  updateMap: boolean;
  absoluteDelta: boolean;
  segmentQuantizer: number[]; // 4 entries (deltas or absolute values)
  segmentFilter: number[];
  filterLevel: number;
  sharpness: number;
  numTokenPartitions: number;
  baseQi: number;
  dqYDc: number;
  dqY2Dc: number;
  dqY2Ac: number;
  dqUvDc: number;
  dqUvAc: number;
  coeffProbUpdates: number;
  useSkipProba: boolean;
  skipProba: number;
  mbs: MbInfo[];
  mbW: number;
  mbH: number;
}

function clip(v: number, max: number): number {
  return v < 0 ? 0 : v > max ? max : v;
}

export function parseVp8Header(vp8: Uint8Array): Vp8Header {
  const tag = vp8[0] | (vp8[1] << 8) | (vp8[2] << 16);
  if (tag & 1) throw new Error("not a keyframe");
  const part0Size = tag >>> 5;
  if (vp8[3] !== 0x9d || vp8[4] !== 0x01 || vp8[5] !== 0x2a) {
    throw new Error("bad start code");
  }
  const width = (vp8[6] | (vp8[7] << 8)) & 0x3fff;
  const height = (vp8[8] | (vp8[9] << 8)) & 0x3fff;
  const mbW = (width + 15) >> 4;
  const mbH = (height + 15) >> 4;

  const br = new BoolDecoder(vp8, 10);
  br.getBit(128); // color space
  br.getBit(128); // clamping

  // segmentation header
  const useSegment = !!br.getBit(128);
  let updateMap = false;
  let absoluteDelta = false;
  const segmentQuantizer = [0, 0, 0, 0];
  const segmentFilter = [0, 0, 0, 0];
  const segmentProbs = [255, 255, 255];
  if (useSegment) {
    updateMap = !!br.getBit(128);
    const updateData = !!br.getBit(128);
    if (updateData) {
      absoluteDelta = !!br.getBit(128);
      for (let i = 0; i < 4; i++) segmentQuantizer[i] = br.getFlaggedSigned(7);
      for (let i = 0; i < 4; i++) segmentFilter[i] = br.getFlaggedSigned(6);
    }
    if (updateMap) {
      for (let i = 0; i < 3; i++) {
        segmentProbs[i] = br.getBit(128) ? br.getValue(8) : 255;
      }
    }
  }

  // filter header
  br.getBit(128); // simple filter
  const filterLevel = br.getValue(6);
  const sharpness = br.getValue(3);
  if (br.getBit(128)) {
    // lf deltas enabled
    if (br.getBit(128)) {
      for (let i = 0; i < 4 + 4; i++) br.getFlaggedSigned(6);
    }
  }

  const numTokenPartitions = 1 << br.getValue(2);

  // quant header
  const baseQi = br.getValue(7);
  const dqYDc = br.getFlaggedSigned(4);
  const dqY2Dc = br.getFlaggedSigned(4);
  const dqY2Ac = br.getFlaggedSigned(4);
  const dqUvDc = br.getFlaggedSigned(4);
  const dqUvAc = br.getFlaggedSigned(4);

  br.getBit(128); // refresh entropy probs (keyframe: ignored)

  // coefficient probability updates
  let coeffProbUpdates = 0;
  for (let t = 0; t < 4; t++) {
    for (let b = 0; b < 8; b++) {
      for (let c = 0; c < 3; c++) {
        for (let p = 0; p < 11; p++) {
          if (br.getBit(COEFFS_UPDATE_PROBA[t][b][c][p])) {
            br.getValue(8);
            coeffProbUpdates++;
          }
        }
      }
    }
  }

  const useSkipProba = !!br.getBit(128);
  const skipProba = useSkipProba ? br.getValue(8) : 0;

  // per-MB intra modes (libwebp ParseIntraMode)
  const mbs: MbInfo[] = [];
  const top = new Uint8Array(4 * mbW); // B_DC_PRED = 0
  for (let mby = 0; mby < mbH; mby++) {
    const left = new Uint8Array(4);
    for (let mbx = 0; mbx < mbW; mbx++) {
      let segment = 0;
      if (useSegment && updateMap) {
        segment = !br.getBit(segmentProbs[0])
          ? br.getBit(segmentProbs[1])
          : br.getBit(segmentProbs[2]) + 2;
      }
      const skip = useSkipProba ? !!br.getBit(skipProba) : null;
      const isI4 = !br.getBit(145);
      let yMode: string;
      let subModes: string[] | undefined;
      if (!isI4) {
        const m = br.getBit(156)
          ? (br.getBit(128) ? 1 /* TM */ : 3 /* H */)
          : (br.getBit(163) ? 2 /* V */ : 0 /* DC */);
        yMode = I16_NAMES[m];
        top.fill(m, 4 * mbx, 4 * mbx + 4);
        left.fill(m);
      } else {
        yMode = "B_PRED";
        subModes = [];
        for (let y = 0; y < 4; y++) {
          let mode = left[y];
          for (let x = 0; x < 4; x++) {
            const prob = KB_MODES_PROBA[top[4 * mbx + x]][mode];
            mode = !br.getBit(prob[0]) ? 0
              : !br.getBit(prob[1]) ? 1
              : !br.getBit(prob[2]) ? 2
              : !br.getBit(prob[3])
                ? (!br.getBit(prob[4]) ? 3 : (!br.getBit(prob[5]) ? 4 : 5))
                : (!br.getBit(prob[6]) ? 6
                  : (!br.getBit(prob[7]) ? 7 : (!br.getBit(prob[8]) ? 8 : 9)));
            subModes.push(B_NAMES[mode]);
            top[4 * mbx + x] = mode;
          }
          left[y] = mode;
        }
      }
      const uvMode = !br.getBit(142) ? 0 : !br.getBit(114) ? 1 : br.getBit(183) ? 3 : 2;
      mbs.push({ segment, skip, isI4, yMode, subModes, uvMode: UV_NAMES[uvMode] });
    }
  }

  return {
    width, height, part0Size, useSegment, updateMap, absoluteDelta,
    segmentQuantizer, segmentFilter, filterLevel, sharpness,
    numTokenPartitions, baseQi, dqYDc, dqY2Dc, dqY2Ac, dqUvDc, dqUvAc,
    coeffProbUpdates, useSkipProba, skipProba, mbs, mbW, mbH,
  };
}

/** Effective dequant step sizes, decoder-side clamping (quant_dec.c). */
export function quantSteps(h: Vp8Header, segment: number): Record<string, number> {
  let q = h.baseQi;
  if (h.useSegment) {
    q = h.absoluteDelta ? h.segmentQuantizer[segment] : q + h.segmentQuantizer[segment];
    q = clip(q, 127);
  }
  const y2ac = Math.max(8, (AC_TABLE[clip(q + h.dqY2Ac, 127)] * 155 / 100) | 0);
  return {
    yDc: DC_TABLE[clip(q + h.dqYDc, 127)],
    yAc: AC_TABLE[q],
    y2Dc: DC_TABLE[clip(q + h.dqY2Dc, 127)] * 2,
    y2Ac: y2ac,
    uvDc: DC_TABLE[clip(q + h.dqUvDc, 117)],
    uvAc: AC_TABLE[clip(q + h.dqUvAc, 127)],
  };
}

function report(name: string, webp: Uint8Array): void {
  const vp8 = extractChunk(webp, "VP8 ");
  if (!vp8) {
    console.log(`${name}: no VP8 chunk (lossless?)`);
    return;
  }
  const h = parseVp8Header(vp8);
  console.log(`=== ${name} ===`);
  console.log(`  ${h.width}x${h.height} (${h.mbW}x${h.mbH} MBs), VP8 ${vp8.length} B, part0 ${h.part0Size} B, ${h.numTokenPartitions} token partition(s)`);
  console.log(
    `  quant: base qi=${h.baseQi}  dq: yDC=${h.dqYDc} y2DC=${h.dqY2Dc} y2AC=${h.dqY2Ac} uvDC=${h.dqUvDc} uvAC=${h.dqUvAc}`,
  );
  if (h.useSegment) {
    console.log(
      `  segments: ON (update_map=${h.updateMap}, ${h.absoluteDelta ? "absolute" : "delta"}) quant=[${h.segmentQuantizer}] filter=[${h.segmentFilter}]`,
    );
    const nSeg = h.updateMap ? 4 : 1;
    for (let s = 0; s < nSeg; s++) {
      const st = quantSteps(h, s);
      console.log(`    seg${s} steps: yDC=${st.yDc} yAC=${st.yAc} y2DC=${st.y2Dc} y2AC=${st.y2Ac} uvDC=${st.uvDc} uvAC=${st.uvAc}`);
    }
  } else {
    const st = quantSteps(h, 0);
    console.log(`  segments: off; steps: yDC=${st.yDc} yAC=${st.yAc} y2DC=${st.y2Dc} y2AC=${st.y2Ac} uvDC=${st.uvDc} uvAC=${st.uvAc}`);
  }
  console.log(`  filter level=${h.filterLevel} sharpness=${h.sharpness}`);
  console.log(`  coeff prob updates: ${h.coeffProbUpdates}; skip: ${h.useSkipProba ? `proba ${h.skipProba}` : "off"}`);
  const counts = new Map<string, number>();
  for (const mb of h.mbs) {
    const key = `y=${mb.yMode}/uv=${mb.uvMode}${mb.skip ? "/skip" : ""}${h.useSegment && h.updateMap ? `/seg${mb.segment}` : ""}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()].sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${n}x ${k}`).join(", ");
  console.log(`  MB modes: ${summary}`);
  if (h.mbs.length <= 4) {
    for (const [i, mb] of h.mbs.entries()) {
      if (mb.subModes) console.log(`    MB${i} sub-modes: ${mb.subModes.join(" ")}`);
    }
  }
}

if (process.argv[1] === import.meta.filename) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node harness/vp8hdr.ts file.webp [...]");
    process.exit(1);
  }
  for (const f of files) report(f, new Uint8Array(await readFile(f)));
}
