// Browser-side benchmark probe: times encodeWebP against the native
// canvas.toBlob('image/webp') on identical content, printing '[bench]' lines
// that harness/bench-browser.ts collects from headless Chrome. Not part of
// the demo app — bundled ad hoc by the runner.

import { encodeWebP } from '../src/index.ts';
import { GENERATORS } from './content.ts';
import jsquashEncode, { init as jsquashInit } from '@jsquash/webp/encode.js';

const SIZES = [96, 256, 512];
const RUNS = 9; // median of RUNS, after warmup

// Content comes from the shared corpus generators, so the benchmark measures
// exactly what the harness measures (sprite is the lossless-path content).
function makeContent(kind, n) {
  return new Uint8ClampedArray(GENERATORS[kind](n, n));
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[s.length >> 1];
}

async function timeNative(canvas, quality) {
  const times = [];
  let bytes = 0;
  for (let r = 0; r < RUNS + 2; r++) {
    const t0 = performance.now();
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/webp', quality));
    const t = performance.now() - t0;
    if (r >= 2) times.push(t);
    bytes = blob?.type === 'image/webp' ? blob.size : 0;
  }
  return { ms: median(times), bytes };
}

function timeOurs(imageData) {
  const times = [];
  let bytes = 0;
  for (let r = 0; r < RUNS + 2; r++) {
    const t0 = performance.now();
    const webp = encodeWebP(imageData, { quality: 80 });
    const t = performance.now() - t0;
    if (r >= 2) times.push(t);
    bytes = webp.length;
  }
  return { ms: median(times), bytes };
}

async function timeWasm(imageData) {
  const times = [];
  let bytes = 0;
  for (let r = 0; r < RUNS + 2; r++) {
    const t0 = performance.now();
    const out = await jsquashEncode(imageData, { quality: 80, method: 0 });
    const t = performance.now() - t0;
    if (r >= 2) times.push(t);
    bytes = out.byteLength;
  }
  return { ms: median(times), bytes };
}

(async () => {
  // WASM one-time cost: download size + compile/instantiate time (the payload
  // our 31 KB bundle is the alternative to)
  const t0 = performance.now();
  const resp = await fetch('/webp_enc_simd.wasm');
  const wasmBytes = await resp.arrayBuffer();
  const wasm = await WebAssembly.compile(wasmBytes);
  await jsquashInit(wasm);
  const initMs = performance.now() - t0;
  console.log(`[bench-init] wasm_b=${wasmBytes.byteLength} init_ms=${initMs.toFixed(1)}`);

  for (const kind of ['photo', 'avatar', 'sprite']) {
    for (const n of SIZES) {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = n;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.putImageData(new ImageData(makeContent(kind, n), n, n), 0, 0);
      const imageData = ctx.getImageData(0, 0, n, n);

      const ours = timeOurs(imageData);
      const native = await timeNative(canvas, 0.80);
      const wasmR = await timeWasm(imageData);
      console.log(
        `[bench] ${kind} ${n} ours_ms=${ours.ms.toFixed(2)} native_ms=${native.ms.toFixed(2)} ` +
          `wasm_ms=${wasmR.ms.toFixed(2)} ours_b=${ours.bytes} native_b=${native.bytes} wasm_b=${wasmR.bytes}`,
      );
    }
  }
  console.log('[bench-done]');
})();
