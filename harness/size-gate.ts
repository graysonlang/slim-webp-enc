// Ship criterion: minified ESM bundle ≤ 55 KB (hard gate, run in CI).
//   node harness/size-gate.ts

import { buildSync } from "esbuild";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const LIMIT = 55 * 1024;

// Build flags must match scripts/dist.mjs — the gate should measure the same
// artifact that gets published, not an esbuild-defaults approximation of it.
const result = buildSync({
  entryPoints: [join(import.meta.dirname, "..", "src", "index.ts")],
  bundle: true,
  minify: true,
  format: "esm",
  target: ["es2020"],
  platform: "neutral",
  legalComments: "none",
  write: false,
});

const bytes = result.outputFiles[0].contents;
const gz = gzipSync(bytes).length;
const ok = bytes.length <= LIMIT;
console.log(
  `minified: ${(bytes.length / 1024).toFixed(1)} KB (gzip ${(gz / 1024).toFixed(1)} KB), ` +
    `limit ${(LIMIT / 1024).toFixed(0)} KB — ${ok ? "OK" : "OVER BUDGET"}`,
);
process.exit(ok ? 0 : 1);
