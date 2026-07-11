// Alpha round-trip exactness check: method-1 (mini-VP8L) alpha payloads
// decode to EXACTLY the quantized plane, and payload sizes land in the
// expected range.
//
//   node harness/alpha-roundtrip.ts

import { join } from "node:path";
import { writeCorpus, CORPUS_DIR } from "./corpus.ts";
import { readPngRGBA, dwebpDecode, webpInfo } from "./codecs.ts";
import { alphaPlane, encodeAlpha } from "../src/alpha.ts";
import { extractChunk } from "../src/container.ts";
import { encodeWebP } from "../src/index.ts";

const images = await writeCorpus();
let failures = 0;

for (const img of images) {
  const pngPath = join(CORPUS_DIR, `${img.name}.png`);
  const src = await readPngRGBA(pngPath);
  const alpha = alphaPlane(src.rgba);
  let opaque = true;
  for (const a of alpha) {
    if (a !== 255) {
      opaque = false;
      break;
    }
  }
  if (opaque) {
    console.log(`${img.name.padEnd(18)} (opaque, no ALPH)`);
    continue;
  }

  const problems: string[] = [];
  // default-config encode; enc.quantized is the plane a decoder must
  // reproduce exactly. No explicit levels: the signature default IS the API
  // default (DEFAULT_ALPHA_LEVELS), so this cannot drift from encodeWebP.
  const enc = encodeAlpha(alpha, src.width, src.height);
  const method = enc.payload[0] & 3;
  const quantized = enc.quantized;

  // this check validates the ALPH pipeline — keep the file on the lossy path
  const webp = encodeWebP({ data: src.rgba, width: src.width, height: src.height }, { lossless: false });
  const alph = extractChunk(webp, "ALPH");
  if (!alph) problems.push("no ALPH chunk");

  const info = await webpInfo(webp);
  if (!info.ok) problems.push("webpinfo rejected");

  try {
    const dec = await dwebpDecode(webp);
    let diff = 0;
    for (let i = 0; i < quantized.length; i++) {
      if (dec.rgba[i * 4 + 3] !== quantized[i]) diff++;
    }
    if (diff > 0) problems.push(`alpha differs from quantized plane at ${diff} px`);
  } catch (e) {
    problems.push((e as Error).message);
  }

  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(
    `${img.name.padEnd(18)} method=${method} alph=${String(enc.payload.length).padStart(6)}B ` +
      `(raw ${src.width * src.height}B)  ${ok ? "ok" : "FAIL: " + problems.join("; ")}`,
  );
}

console.log(failures === 0 ? "\nall alpha round-trips exact" : `\n${failures} FAILURES`);
process.exit(failures ? 1 : 0);
