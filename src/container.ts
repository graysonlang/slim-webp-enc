// RIFF/WebP container: chunk assembly (VP8X + ALPH + VP8) and minimal parsing.
// Layout per the WebP Container Specification.

const ALPHA_FLAG = 0x10;

function fourcc(s: string): number[] {
  return [s.charCodeAt(0), s.charCodeAt(1), s.charCodeAt(2), s.charCodeAt(3)];
}

function u32le(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff, (v >>> 24) & 0xff];
}

function u24le(v: number): number[] {
  return [v & 0xff, (v >>> 8) & 0xff, (v >>> 16) & 0xff];
}

/** A chunk is fourcc + u32le payload size + payload + pad byte if payload size is odd. */
function chunk(cc: string, payload: Uint8Array): Uint8Array {
  const padded = payload.length + (payload.length & 1);
  const out = new Uint8Array(8 + padded);
  out.set(fourcc(cc), 0);
  out.set(u32le(payload.length), 4);
  out.set(payload, 8);
  // pad byte (if any) is already 0
  return out;
}

export interface ContainerParts {
  width: number;
  height: number;
  /** VP8 bitstream (payload of the "VP8 " chunk). */
  vp8: Uint8Array;
  /** ALPH chunk payload (header byte + data). Omit for opaque images. */
  alph?: Uint8Array;
}

/**
 * Assemble a WebP file. With alpha: RIFF > VP8X + ALPH + "VP8 ".
 * Without: the simple format, RIFF > "VP8 " only.
 */
export function buildWebP(parts: ContainerParts): Uint8Array {
  const chunks: Uint8Array[] = [];
  if (parts.alph) {
    const vp8x = new Uint8Array(10);
    vp8x[0] = ALPHA_FLAG;
    vp8x.set(u24le(parts.width - 1), 4);
    vp8x.set(u24le(parts.height - 1), 7);
    chunks.push(chunk("VP8X", vp8x));
    chunks.push(chunk("ALPH", parts.alph));
  }
  chunks.push(chunk("VP8 ", parts.vp8));

  const bodyLen = chunks.reduce((n, c) => n + c.length, 0);
  const out = new Uint8Array(12 + bodyLen);
  out.set(fourcc("RIFF"), 0);
  out.set(u32le(4 + bodyLen), 4); // "WEBP" + chunks
  out.set(fourcc("WEBP"), 8);
  let off = 12;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

/**
 * Assemble a lossless WebP file: RIFF > "VP8L" only (the simple lossless
 * format; dimensions and the alpha hint live inside the VP8L header).
 */
export function buildWebPLossless(vp8l: Uint8Array): Uint8Array {
  const c = chunk("VP8L", vp8l);
  const out = new Uint8Array(12 + c.length);
  out.set(fourcc("RIFF"), 0);
  out.set(u32le(4 + c.length), 4);
  out.set(fourcc("WEBP"), 8);
  out.set(c, 12);
  return out;
}

/** Extract a chunk payload by fourcc from a WebP file. Returns null if absent. */
export function extractChunk(webp: Uint8Array, cc: string): Uint8Array | null {
  if (webp.length < 12) return null;
  const tag = (o: number) => String.fromCharCode(webp[o], webp[o + 1], webp[o + 2], webp[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WEBP") return null;
  let off = 12;
  while (off + 8 <= webp.length) {
    const size = webp[off + 4] | (webp[off + 5] << 8) | (webp[off + 6] << 16) | (webp[off + 7] << 24);
    if (tag(off) === cc) return webp.subarray(off + 8, off + 8 + size);
    off += 8 + size + (size & 1);
  }
  return null;
}
