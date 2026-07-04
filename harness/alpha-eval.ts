// Alpha preprocessing trade-off evaluation: uniform grid vs adaptive
// (Lloyd-Max) level reduction, with and without dithering. For each
// alpha-carrying corpus image (plus the demo's alpha ramp) reports the alpha
// plane's RMSE/PSNR against the source and the ALPH payload size, and
// verifies the file still decodes exactly via dwebp.
//
//   node harness/alpha-eval.ts [--levels=16]

import { join } from "node:path";
import { writeCorpus, CORPUS_DIR } from "./corpus.ts";
import { readPngRGBA, dwebpDecode } from "./codecs.ts";
import { alphaPlane, encodeAlpha, type AlphaLevels } from "../src/alpha.ts";
import { buildWebP, extractChunk } from "../src/container.ts";
import { encodeWebP } from "../src/index.ts";

const levelsArg = process.argv.find((a) => a.startsWith("--levels="));
const LEVELS = (levelsArg ? Number(levelsArg.slice(9)) : 16) as AlphaLevels;

interface Source {
  name: string;
  width: number;
  height: number;
  rgba: Uint8Array;
}

const sources: Source[] = [];
for (const img of await writeCorpus()) {
  const src = await readPngRGBA(join(CORPUS_DIR, `${img.name}.png`));
  const alpha = alphaPlane(src.rgba);
  if (alpha.some((a) => a !== 255)) {
    sources.push({ name: img.name, width: src.width, height: src.height, rgba: src.rgba });
  }
}
{
  // the demo's alpha ramp — worst case for banding and for dither cost
  const w = 256;
  const h = 128;
  const clamp = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : Math.round(v));
  const rgba = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const i = (y * w + x) * 4;
      rgba[i] = clamp(255 * (1 - u));
      rgba[i + 1] = clamp(160 * (y / (h - 1)) + 60);
      rgba[i + 2] = clamp(255 * u);
      rgba[i + 3] = clamp(u * 255);
    }
  }
  sources.push({ name: "alpha-ramp", width: w, height: h, rgba });
}

const CONFIGS: Array<{ label: string; adaptive: boolean; dither: number }> = [
  { label: "uniform", adaptive: false, dither: 0 },
  { label: "uniform+dither", adaptive: false, dither: 1 },
  { label: "adaptive", adaptive: true, dither: 0 },
  { label: "adaptive+dither", adaptive: true, dither: 1 },
];

console.log(`levels=${LEVELS}\n`);
console.log(
  `${"image".padEnd(16)}${"config".padEnd(17)}${"alph B".padStart(8)}` +
    `${"RMSE".padStart(7)}${"PSNR".padStart(8)}${"exact".padStart(7)}`,
);

const totals = new Map<string, { bytes: number; se: number; n: number }>();

for (const src of sources) {
  const alpha = alphaPlane(src.rgba);
  for (const cfg of CONFIGS) {
    const enc = encodeAlpha(alpha, src.width, src.height, LEVELS, cfg.dither, cfg.adaptive);

    let se = 0;
    for (let i = 0; i < alpha.length; i++) {
      const d = alpha[i] - enc.quantized[i];
      se += d * d;
    }
    const rmse = Math.sqrt(se / alpha.length);
    const psnr = se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (se / alpha.length));

    // full-file decode check: decoded alpha must equal the quantized plane
    const webp = encodeWebP(
      { data: src.rgba, width: src.width, height: src.height },
      { quality: 75, alphaLevels: LEVELS, alphaDither: cfg.dither, alphaAdaptive: cfg.adaptive, lossless: false },
    );
    const vp8 = extractChunk(webp, "VP8 ");
    if (!vp8) throw new Error("no VP8 chunk");
    const file = buildWebP({ width: src.width, height: src.height, vp8, alph: enc.payload });
    let exact = false;
    try {
      const dec = await dwebpDecode(file);
      exact = enc.quantized.every((q, i) => dec.rgba[i * 4 + 3] === q);
    } catch {
      exact = false;
    }

    const t = totals.get(cfg.label) ?? { bytes: 0, se: 0, n: 0 };
    t.bytes += enc.payload.length;
    t.se += se;
    t.n += alpha.length;
    totals.set(cfg.label, t);

    console.log(
      `${src.name.padEnd(16)}${cfg.label.padEnd(17)}${String(enc.payload.length).padStart(8)}` +
        `${rmse.toFixed(2).padStart(7)}${(Number.isFinite(psnr) ? psnr.toFixed(1) : "∞").padStart(8)}` +
        `${(exact ? "ok" : "FAIL").padStart(7)}`,
    );
  }
  console.log();
}

console.log("totals:");
for (const [label, t] of totals) {
  const psnr = t.se === 0 ? Infinity : 10 * Math.log10((255 * 255) / (t.se / t.n));
  console.log(
    `${label.padEnd(17)}${String(t.bytes).padStart(8)} B` +
      `${(Number.isFinite(psnr) ? psnr.toFixed(1) : "∞").padStart(8)} dB`,
  );
}
