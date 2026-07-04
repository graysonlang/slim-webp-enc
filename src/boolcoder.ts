// VP8 boolean (arithmetic) encoder, RFC 6386 §7.
// Port of libwebp's VP8BitWriter (utils/bit_writer_utils.c), including the
// delayed-0xff carry propagation.

const K_NORM: number[] = [
  7, 6, 6, 5, 5, 5, 5, 4, 4, 4, 4, 4, 4, 4, 4, 3, 3, 3, 3, 3, 3, 3,
  3, 3, 3, 3, 3, 3, 3, 3, 3, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2,
  2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0,
];

// new range = ((range + 1) << K_NORM[range]) - 1
const K_NEW_RANGE: number[] = [
  127, 127, 191, 127, 159, 191, 223, 127, 143, 159, 175, 191, 207, 223, 239,
  127, 135, 143, 151, 159, 167, 175, 183, 191, 199, 207, 215, 223, 231, 239,
  247, 127, 131, 135, 139, 143, 147, 151, 155, 159, 163, 167, 171, 175, 179,
  183, 187, 191, 195, 199, 203, 207, 211, 215, 219, 223, 227, 231, 235, 239,
  243, 247, 251, 127, 129, 131, 133, 135, 137, 139, 141, 143, 145, 147, 149,
  151, 153, 155, 157, 159, 161, 163, 165, 167, 169, 171, 173, 175, 177, 179,
  181, 183, 185, 187, 189, 191, 193, 195, 197, 199, 201, 203, 205, 207, 209,
  211, 213, 215, 217, 219, 221, 223, 225, 227, 229, 231, 233, 235, 237, 239,
  241, 243, 245, 247, 249, 251, 253, 127,
];

export class BoolEncoder {
  private range = 254;
  private value = 0;
  private run = 0; // number of pending 0xff bytes
  private nbBits = -8;
  private buf: number[] = [];

  private flush(): void {
    const s = 8 + this.nbBits;
    const bits = this.value >> s;
    this.value -= bits << s;
    this.nbBits -= 8;
    if ((bits & 0xff) !== 0xff) {
      if (bits & 0x100) {
        // carry over pending 0xff's and the last written byte
        const last = this.buf.length - 1;
        if (last >= 0) this.buf[last]++;
      }
      const fill = bits & 0x100 ? 0x00 : 0xff;
      for (; this.run > 0; this.run--) this.buf.push(fill);
      this.buf.push(bits & 0xff);
    } else {
      this.run++; // delay writing 0xff, pending eventual carry
    }
  }

  /** Code one bool with probability `prob` (of a 0) out of 256. */
  putBit(bit: number | boolean, prob: number): boolean {
    const b = bit ? 1 : 0;
    const split = (this.range * prob) >> 8;
    if (b) {
      this.value += split + 1;
      this.range -= split + 1;
    } else {
      this.range = split;
    }
    if (this.range < 127) {
      const shift = K_NORM[this.range];
      this.range = K_NEW_RANGE[this.range];
      this.value <<= shift;
      this.nbBits += shift;
      if (this.nbBits > 0) this.flush();
    }
    return !!b;
  }

  /** Code one bool with probability 1/2. */
  putBitUniform(bit: number | boolean): boolean {
    const b = bit ? 1 : 0;
    const split = this.range >> 1;
    if (b) {
      this.value += split + 1;
      this.range -= split + 1;
    } else {
      this.range = split;
    }
    if (this.range < 127) {
      this.range = K_NEW_RANGE[this.range];
      this.value <<= 1;
      this.nbBits += 1;
      if (this.nbBits > 0) this.flush();
    }
    return !!b;
  }

  /** Write a literal value MSB-first, each bit at probability 1/2. */
  putBits(value: number, nbBits: number): void {
    for (let mask = 1 << (nbBits - 1); mask; mask >>>= 1) {
      this.putBitUniform(value & mask);
    }
  }

  /** flag + sign + magnitude, as used for quantizer/filter deltas. */
  putSignedBits(value: number, nbBits: number): void {
    if (!this.putBitUniform(value !== 0)) return;
    if (value < 0) {
      this.putBits((-value << 1) | 1, nbBits + 1);
    } else {
      this.putBits(value << 1, nbBits + 1);
    }
  }

  finish(): Uint8Array {
    this.putBits(0, 9 - this.nbBits);
    this.nbBits = 0;
    this.flush();
    return new Uint8Array(this.buf);
  }
}
