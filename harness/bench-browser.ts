// Browser benchmark runner: bundles bench-probe.js, serves it, runs headless
// Chrome, and reports ours-vs-native canvas.toBlob('image/webp') timings.
//
//   node harness/bench-browser.ts

import { buildSync } from "esbuild";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

const CHROME =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const bundle = buildSync({
  entryPoints: [join(import.meta.dirname, "bench-probe.js")],
  bundle: true,
  format: "esm",
  write: false,
});
const js = bundle.outputFiles[0].text;
const html = `<!DOCTYPE html><script type="module">${js}</script>`;

const wasm = readFileSync(
  join(import.meta.dirname, "..", "node_modules", "@jsquash", "webp", "codec", "enc", "webp_enc_simd.wasm"),
);

const server = createServer((req, res) => {
  if (req.url?.endsWith(".wasm")) {
    res.setHeader("content-type", "application/wasm");
    res.end(wasm);
    return;
  }
  res.setHeader("content-type", "text/html");
  res.end(html);
});
await new Promise<void>((res) => server.listen(0, "127.0.0.1", res));
const addr = server.address();
if (addr === null || typeof addr !== "object") throw new Error("no server address");

const chrome = spawn(
  CHROME,
  ["--headless=new", "--disable-gpu", "--enable-logging=stderr", "--v=0",
    `http://127.0.0.1:${addr.port}/`],
  { stdio: ["ignore", "ignore", "pipe"] },
);

interface Row {
  kind: string;
  size: number;
  oursMs: number;
  nativeMs: number;
  wasmMs: number;
  oursB: number;
  nativeB: number;
  wasmB: number;
}
const rows: Row[] = [];
let init = { wasmB: 0, initMs: 0 };
let buf = "";

const done = new Promise<void>((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("benchmark timed out")), 120_000);
  chrome.stderr.on("data", (chunk: Buffer) => {
    buf += chunk.toString();
    for (;;) {
      const idx = buf.indexOf("\n");
      if (idx < 0) break;
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      const mi = /\[bench-init\] wasm_b=(\d+) init_ms=([\d.]+)/.exec(line);
      if (mi) init = { wasmB: Number(mi[1]), initMs: Number(mi[2]) };
      const m =
        /\[bench\] (\w+) (\d+) ours_ms=([\d.]+) native_ms=([\d.]+) wasm_ms=([\d.]+) ours_b=(\d+) native_b=(\d+) wasm_b=(\d+)/.exec(line);
      if (m) {
        rows.push({
          kind: m[1],
          size: Number(m[2]),
          oursMs: Number(m[3]),
          nativeMs: Number(m[4]),
          wasmMs: Number(m[5]),
          oursB: Number(m[6]),
          nativeB: Number(m[7]),
          wasmB: Number(m[8]),
        });
      }
      if (line.includes("[bench-done]")) {
        clearTimeout(timeout);
        resolve();
      }
    }
  });
});

try {
  await done;
} finally {
  chrome.kill();
  server.close();
}

console.log(
  `wasm one-time cost: ${(init.wasmB / 1024).toFixed(0)} KB download + ` +
    `${init.initMs.toFixed(0)} ms compile/init (ours: 32 KB bundle, no init)\n`,
);
console.log(
  `${"content".padEnd(9)}${"size".padStart(6)}${"ours ms".padStart(9)}${"native ms".padStart(11)}` +
    `${"wasm ms".padStart(9)}${"ours B".padStart(9)}${"native B".padStart(10)}${"wasm B".padStart(9)}`,
);
for (const r of rows) {
  console.log(
    `${r.kind.padEnd(9)}${String(r.size).padStart(6)}${r.oursMs.toFixed(1).padStart(9)}` +
      `${r.nativeMs.toFixed(1).padStart(11)}${r.wasmMs.toFixed(1).padStart(9)}` +
      `${String(r.oursB).padStart(9)}${String(r.nativeB).padStart(10)}${String(r.wasmB).padStart(9)}`,
  );
}
