// VP8-core size check: our VP8 chunk size vs cwebp -m 0 at matched SSIM
// (target: ≤ ~25% overhead). For each corpus image, encode ours at --q, then
// sweep cwebp quality to find the closest SSIM match, and compare VP8 chunk
// sizes.
//
//   node harness/compare.ts [--q=75]

import { join } from "node:path";
import { writeCorpus, CORPUS_DIR } from "./corpus.ts";
import { readPngRGBA, cwebpEncode, dwebpDecode } from "./codecs.ts";
import { compareRGBA } from "./metrics.ts";
import { extractChunk } from "../src/container.ts";
import { encodeWebP } from "../src/index.ts";

const qArg = process.argv.find((a) => a.startsWith("--q="));
const quality = qArg ? Number(qArg.slice(4)) : 75;

const images = await writeCorpus();
let totalOurs = 0;
let totalRef = 0;

console.log(
  `${"image".padEnd(18)}${"oursVP8".padStart(9)}${"SSIM".padStart(7)}` +
    `${"cwebpVP8".padStart(10)}${"SSIM".padStart(7)}${"cwebp-q".padStart(9)}${"Δsize".padStart(8)}`,
);

for (const img of images) {
  const pngPath = join(CORPUS_DIR, `${img.name}.png`);
  const src = await readPngRGBA(pngPath);

  // this tool benchmarks the lossy VP8 core specifically — disable the
  // lossless candidate so flat images don't switch to VP8L, and alpha dither
  // so the composite-SSIM anchor reflects VP8 fidelity rather than alpha noise
  // (dither lowers our SSIM, which lets the sweep match cwebp at a much lower
  // q and inflates the apparent VP8 overhead)
  const ours = encodeWebP(
    { data: src.rgba, width: src.width, height: src.height },
    { quality, lossless: false, alphaDither: 0 },
  );
  const oursVp8 = extractChunk(ours, "VP8 ")!.length;
  const oursDec = await dwebpDecode(ours);
  const oursSsim = compareRGBA(src.rgba, oursDec.rgba, src.width, src.height).ssim;

  // sweep cwebp quality for closest SSIM at or above ours
  let best = { q: 75, size: 0, ssim: 0, diff: Infinity };
  for (let q = 30; q <= 95; q += 5) {
    const ref = await cwebpEncode(pngPath, { quality: q, method: 0, exact: false });
    const refVp8 = extractChunk(ref, "VP8 ")!.length;
    const refDec = await dwebpDecode(ref);
    const refSsim = compareRGBA(src.rgba, refDec.rgba, src.width, src.height).ssim;
    const diff = Math.abs(refSsim - oursSsim);
    if (diff < best.diff) best = { q, size: refVp8, ssim: refSsim, diff };
  }

  totalOurs += oursVp8;
  totalRef += best.size;
  const delta = ((oursVp8 / best.size - 1) * 100).toFixed(0);
  console.log(
    `${img.name.padEnd(18)}${String(oursVp8).padStart(9)}${oursSsim.toFixed(3).padStart(7)}` +
      `${String(best.size).padStart(10)}${best.ssim.toFixed(3).padStart(7)}` +
      `${String(best.q).padStart(9)}${(delta + "%").padStart(8)}`,
  );
}

const overall = ((totalOurs / totalRef - 1) * 100).toFixed(1);
console.log(`\ntotal ours=${totalOurs} cwebp=${totalRef}  overhead=${overall}% (target ≤ ~25%)`);
