// Benchmark: encode time + full-file size vs @jsquash/webp (libwebp WASM)
// and cwebp -m 0, on the corpus at q75.
//
//   node harness/bench.ts

import { join } from "node:path";
import { writeCorpus, CORPUS_DIR } from "./corpus.ts";
import { readPngRGBA, cwebpEncode } from "./codecs.ts";
import { encodeWebP } from "../src/index.ts";

// @jsquash/webp targets browsers; its node usage needs the raw wasm module.
async function makeJsquash(): Promise<((data: ImageData, q: number) => Promise<ArrayBuffer>) | null> {
  try {
    const { readFile } = await import("node:fs/promises");
    const mod = await import("@jsquash/webp/encode.js" as string);
    const wasmPath = join(
      import.meta.dirname, "..", "node_modules", "@jsquash", "webp", "codec", "enc", "webp_enc_simd.wasm",
    );
    const wasm = await WebAssembly.compile(await readFile(wasmPath));
    await mod.init(wasm);
    return async (img, quality) => mod.default(img, { quality, method: 0 });
  } catch (e) {
    console.log(`(jsquash init failed: ${(e as Error).message})`);
    return null;
  }
}

const jsquash = await makeJsquash();
if (!jsquash) console.log("(jsquash unavailable in this runtime — skipping column)\n");

const images = await writeCorpus();
console.log(
  `${"image".padEnd(18)}${"slim B".padStart(9)}${"slim ms".padStart(9)}` +
    `${"jsq B".padStart(9)}${"jsq ms".padStart(9)}${"cwebp B".padStart(9)}`,
);

const totals = { slim: 0, slimMs: 0, jsq: 0, jsqMs: 0, cwebp: 0 };
for (const img of images) {
  const pngPath = join(CORPUS_DIR, `${img.name}.png`);
  const src = await readPngRGBA(pngPath);
  const imageData = { data: src.rgba, width: src.width, height: src.height };

  // warm + best-of-3 for ours
  let slimMs = Infinity;
  let slim: Uint8Array = new Uint8Array();
  for (let i = 0; i < 3; i++) {
    const t = performance.now();
    slim = encodeWebP(imageData, { quality: 75 });
    slimMs = Math.min(slimMs, performance.now() - t);
  }

  let jsqBytes = 0;
  let jsqMs = 0;
  if (jsquash) {
    const idata = { data: new Uint8ClampedArray(src.rgba), width: src.width, height: src.height, colorSpace: "srgb" } as ImageData;
    await jsquash(idata, 75); // warm
    const t = performance.now();
    const out = await jsquash(idata, 75);
    jsqMs = performance.now() - t;
    jsqBytes = out.byteLength;
  }

  const ref = await cwebpEncode(pngPath, { quality: 75, method: 0, exact: false });

  totals.slim += slim.length;
  totals.slimMs += slimMs;
  totals.jsq += jsqBytes;
  totals.jsqMs += jsqMs;
  totals.cwebp += ref.length;
  console.log(
    `${img.name.padEnd(18)}${String(slim.length).padStart(9)}${slimMs.toFixed(1).padStart(9)}` +
      `${String(jsqBytes).padStart(9)}${jsqMs.toFixed(1).padStart(9)}${String(ref.length).padStart(9)}`,
  );
}
console.log(
  `${"TOTAL".padEnd(18)}${String(totals.slim).padStart(9)}${totals.slimMs.toFixed(0).padStart(9)}` +
    `${String(totals.jsq).padStart(9)}${totals.jsqMs.toFixed(0).padStart(9)}${String(totals.cwebp).padStart(9)}`,
);
