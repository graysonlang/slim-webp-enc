// Round-trip harness: encode corpus → webpinfo structural check → dwebp decode
// → metrics vs source. Usage:
//
//   node harness/run.ts [--encoder=cwebp|hybrid|slim] [--q=75]

import { mkdirSync, existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { writeCorpus, CORPUS_DIR } from "./corpus.ts";
import { readPngRGBA, cwebpEncode, dwebpDecode, webpInfo, type RawImage } from "./codecs.ts";
import { compareRGBA, alphaMaxDiff } from "./metrics.ts";

interface EncodeInput extends RawImage {
  pngPath: string;
}

type Encoder = (img: EncodeInput, opts: { quality: number }) => Promise<Uint8Array>;

const ENCODERS: Record<string, Encoder> = {
  // Reference path: proves the harness itself against a known-good encoder.
  cwebp: (img, opts) => cwebpEncode(img.pngPath, { quality: opts.quality, method: 0 }),
  // Isolation path: our container + ALPH around a borrowed cwebp VP8 chunk.
  hybrid: async (img, opts) => {
    const { hybridEncode } = await import("./hybrid.ts");
    const r = await hybridEncode(img.pngPath, img.rgba, img.width, img.height, {
      quality: opts.quality,
    });
    return r.webp;
  },
  // Our encoder.
  slim: async (img, opts) => {
    const mod = await import("../src/index.ts");
    return mod.encodeWebP(
      { data: img.rgba, width: img.width, height: img.height },
      { quality: opts.quality },
    );
  },
};

interface Result {
  name: string;
  bytes: number;
  encodeMs: number;
  structOk: boolean;
  psnr: number;
  ssim: number;
  alphaMaxDiff: number;
  error?: string;
}

function parseArgs(): { encoder: string; quality: number } {
  let encoder = "cwebp";
  let quality = 75;
  for (const arg of process.argv.slice(2)) {
    const m = /^--(\w+)=(.+)$/.exec(arg);
    if (!m) continue;
    if (m[1] === "encoder") encoder = m[2];
    if (m[1] === "q") quality = Number(m[2]);
  }
  return { encoder, quality };
}

const { encoder: encoderName, quality } = parseArgs();
const encode = ENCODERS[encoderName];
if (!encode) {
  console.error(`unknown encoder "${encoderName}" (have: ${Object.keys(ENCODERS).join(", ")})`);
  process.exit(1);
}

const OUT_DIR = join(import.meta.dirname, "..", "out");
mkdirSync(OUT_DIR, { recursive: true });

const images = await writeCorpus();
const results: Result[] = [];

for (const img of images) {
  const pngPath = join(CORPUS_DIR, `${img.name}.png`);
  const src = await readPngRGBA(pngPath);
  const input: EncodeInput = { ...src, pngPath };
  const res: Result = {
    name: img.name,
    bytes: 0,
    encodeMs: 0,
    structOk: false,
    psnr: NaN,
    ssim: NaN,
    alphaMaxDiff: -1,
  };
  try {
    const t0 = performance.now();
    const webp = await encode(input, { quality });
    res.encodeMs = performance.now() - t0;
    res.bytes = webp.length;
    writeFileSync(join(OUT_DIR, `${img.name}.${encoderName}.webp`), webp);

    const info = await webpInfo(webp);
    res.structOk = info.ok;
    if (!info.ok) {
      res.error = `webpinfo: ${lastLines(info.report, 3)}`;
    }

    const dec = await dwebpDecode(webp);
    if (dec.width !== src.width || dec.height !== src.height) {
      throw new Error(`decoded size ${dec.width}x${dec.height} != ${src.width}x${src.height}`);
    }
    const m = compareRGBA(src.rgba, dec.rgba, src.width, src.height);
    res.psnr = m.psnr;
    res.ssim = m.ssim;
    res.alphaMaxDiff = alphaMaxDiff(src.rgba, dec.rgba);
  } catch (e) {
    res.error = (res.error ? res.error + "; " : "") + (e as Error).message;
  }
  results.push(res);
}

function lastLines(s: string, n: number): string {
  return s.trim().split("\n").slice(-n).join(" | ");
}

// --- report ---
const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(
  `\nencoder=${encoderName} q=${quality}\n` +
    `${"image".padEnd(18)}${pad("bytes", 8)}${pad("ms", 8)}${pad("struct", 8)}` +
    `${pad("PSNR", 8)}${pad("SSIM", 8)}${pad("aDiff", 7)}  notes`,
);
let failures = 0;
for (const r of results) {
  const bad = !r.structOk || r.error || !(r.psnr > 25) || !(r.ssim > 0.85);
  if (bad) failures++;
  console.log(
    `${r.name.padEnd(18)}${pad(r.bytes, 8)}${pad(r.encodeMs.toFixed(1), 8)}` +
      `${pad(r.structOk ? "ok" : "FAIL", 8)}` +
      `${pad(Number.isFinite(r.psnr) ? r.psnr.toFixed(1) : String(r.psnr), 8)}` +
      `${pad(Number.isFinite(r.ssim) ? r.ssim.toFixed(3) : String(r.ssim), 8)}` +
      `${pad(r.alphaMaxDiff, 7)}` +
      `  ${bad ? "✗ " : ""}${r.error ?? ""}`,
  );
}

writeFileSync(
  join(OUT_DIR, `results-${encoderName}.json`),
  JSON.stringify({ encoder: encoderName, quality, results }, null, 2),
);

console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures > 0 ? 1 : 0);
