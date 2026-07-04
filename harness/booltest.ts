// Round-trips random bool sequences through BoolEncoder and a straight
// RFC 6386 §7.2-style boolean decoder. Catches carry/renormalization bugs
// in isolation, before the full VP8 pipeline exists.

import { BoolEncoder } from "../src/boolcoder.ts";
import { mulberry32 } from "./content.ts";

class BoolDecoder {
  private value = 0;
  private range = 255;
  private bitCount = 0;
  private pos = 0;
  private buf: Uint8Array;
  constructor(buf: Uint8Array) {
    this.buf = buf;
    for (let i = 0; i < 2; i++) {
      this.value = (this.value << 8) | (this.buf[this.pos++] ?? 0);
    }
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
        this.value |= this.buf[this.pos++] ?? 0;
      }
    }
    return ret;
  }
}

let failures = 0;
for (let trial = 0; trial < 200; trial++) {
  const rng = mulberry32(trial * 7919 + 1);
  const n = 1 + Math.floor(rng() * 5000);
  const bits: number[] = [];
  const probs: number[] = [];
  for (let i = 0; i < n; i++) {
    // skew probabilities to stress carry runs (long strings of 0xff bytes)
    const p = trial % 3 === 0 ? 1 + Math.floor(rng() * 254)
            : trial % 3 === 1 ? 250 : 3;
    const bit = rng() < (trial % 3 === 1 ? 0.97 : 0.5) ? 1 : 0;
    probs.push(p);
    bits.push(bit);
  }
  const enc = new BoolEncoder();
  for (let i = 0; i < n; i++) enc.putBit(bits[i], probs[i]);
  const bytes = enc.finish();
  const dec = new BoolDecoder(bytes);
  for (let i = 0; i < n; i++) {
    if (dec.getBit(probs[i]) !== bits[i]) {
      console.log(`trial ${trial}: mismatch at bit ${i}/${n}`);
      failures++;
      break;
    }
  }
}
console.log(failures === 0 ? "bool coder: 200/200 round-trips ok" : `${failures} FAILURES`);
process.exit(failures ? 1 : 0);
