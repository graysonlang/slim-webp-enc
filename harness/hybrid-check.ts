// Container/alpha isolation check, using the hybrid encoder (a borrowed
// cwebp VP8 chunk in our container — see hybrid.ts):
//   - webpinfo accepts the hybrid file
//   - dwebp decodes it; RGB matches decoding the cwebp donor exactly
//   - decoded alpha matches our quantized plane exactly
//
//   node harness/hybrid-check.ts

import { join } from "node:path";
import { writeCorpus, CORPUS_DIR } from "./corpus.ts";
import { readPngRGBA, cwebpEncode, dwebpDecode, webpInfo } from "./codecs.ts";
import { hybridEncode } from "./hybrid.ts";

const images = await writeCorpus();
let failures = 0;

for (const img of images) {
  const pngPath = join(CORPUS_DIR, `${img.name}.png`);
  const src = await readPngRGBA(pngPath);
  const problems: string[] = [];
  let filter = -1;
  try {
    const fr = await hybridEncode(pngPath, src.rgba, src.width, src.height);
    filter = fr.filter;

    const info = await webpInfo(fr.webp);
    if (!info.ok) {
      problems.push(`webpinfo rejected: ${info.report.trim().split("\n").slice(-2).join(" | ")}`);
    }

    const ours = await dwebpDecode(fr.webp);
    const donor = await dwebpDecode(await cwebpEncode(pngPath, { quality: 75, method: 0 }));

    // RGB must match the donor decode byte-for-byte (same VP8 chunk).
    let rgbDiff = 0;
    for (let i = 0; i < ours.rgba.length; i += 4) {
      if (
        ours.rgba[i] !== donor.rgba[i] ||
        ours.rgba[i + 1] !== donor.rgba[i + 1] ||
        ours.rgba[i + 2] !== donor.rgba[i + 2]
      ) rgbDiff++;
    }
    if (rgbDiff > 0) problems.push(`RGB differs from donor at ${rgbDiff} px`);

    // Alpha must reconstruct the quantized plane exactly.
    let alphaDiff = 0;
    for (let i = 0; i < fr.quantizedAlpha.length; i++) {
      if (ours.rgba[i * 4 + 3] !== fr.quantizedAlpha[i]) alphaDiff++;
    }
    if (alphaDiff > 0) problems.push(`alpha differs from quantized plane at ${alphaDiff} px`);
  } catch (e) {
    problems.push((e as Error).message);
  }

  const ok = problems.length === 0;
  if (!ok) failures++;
  console.log(
    `${img.name.padEnd(18)} filter=${filter}  ${ok ? "ok" : "FAIL: " + problems.join("; ")}`,
  );
}

console.log(`\n${images.length - failures}/${images.length} passed`);
process.exit(failures > 0 ? 1 : 0);
