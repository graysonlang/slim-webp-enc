// Hybrid encoder: borrow the VP8 chunk from a cwebp encode of the same
// image, wrap it in OUR container with OUR (method-0) ALPH chunk.
// Exercises the RIFF/VP8X/ALPH plumbing and the whole alpha path in isolation
// from our VP8 code — if a file is corrupt here, the bug is in the container
// or alpha path, not the VP8 encoder.

import { buildWebP, extractChunk } from "../src/container.ts";
import { encodeAlphaMethod0, alphaPlane, type AlphaLevels } from "../src/alpha.ts";
import { cwebpEncode } from "./codecs.ts";

export interface HybridResult {
  webp: Uint8Array;
  /** Alpha plane a compliant decoder must reproduce exactly. */
  quantizedAlpha: Uint8Array;
  filter: number;
}

export async function hybridEncode(
  pngPath: string,
  rgba: Uint8Array,
  width: number,
  height: number,
  opts: { quality?: number; alphaLevels?: AlphaLevels } = {},
): Promise<HybridResult> {
  const donor = await cwebpEncode(pngPath, { quality: opts.quality ?? 75, method: 0 });
  const vp8 = extractChunk(donor, "VP8 ");
  if (!vp8) throw new Error("donor file has no VP8 chunk");
  const alpha = encodeAlphaMethod0(alphaPlane(rgba), width, height, opts.alphaLevels ?? 16);
  const webp = buildWebP({ width, height, vp8, alph: alpha.payload });
  return { webp, quantizedAlpha: alpha.quantized, filter: alpha.filter };
}
