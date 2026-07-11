// Bulk parity sweep over real image files — e.g. a list of macOS system
// assets — comparing slim against libwebp (@jsquash/webp at method 3, the
// Chromium canvas configuration) at the same quality.
//
//   node harness/syseval.ts --list=assets.txt [options]
//
// The list is one path per line (surrounding quotes ok, e.g. `find` output
// piped through quoting, or a pasted file listing). PNG/JPEG are read
// directly; .icns is converted via `sips` (macOS built-in). Unlike corpus.ts
// this does not touch corpus/ — the CI corpus stays deterministic; this is a
// separate, machine-local evaluation.
//
// Options:
//   --q=75            quality for both encoders (default 75)
//   --limit=N         stop after N evaluated files
//   --stride=N        evaluate every Nth file (deterministic sampling)
//   --max-dim=1024    downscale anything larger (0 = never downscale)
//   --min-dim=8       skip images smaller than this on either axis
//   --lossless=off    slim lossless mode: off | auto (default off — isolates
//                     the lossy VP8 core; auto measures shipping behavior)
//   --effort=quality  slim effort: quality | fast
//   --alpha-levels=32 slim alphaLevels (8 | 16 | 32)
//   --csv=path        write per-file rows for offline analysis
//   --worst=10        how many worst cases to print per ranking
//
// Output: per-file progress to stderr, then a summary — total bytes ratio,
// PSNR-delta distribution, and the worst files by quality and by size — so
// regressions hunt themselves.

import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { encodeWebP } from "../src/index.ts";
import { extractChunk } from "../src/container.ts";
import { psnrPerChannelAlphaWeighted } from "./metrics.ts";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// CLI

const args = process.argv.slice(2);
const argOf = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const listPath = argOf("list");
if (!listPath) {
  console.error("usage: node harness/syseval.ts --list=assets.txt [--q=75] [--limit=N] ...");
  process.exit(1);
}
const quality = Number(argOf("q") ?? 75);
const limit = Number(argOf("limit") ?? Infinity);
const stride = Math.max(1, Number(argOf("stride") ?? 1));
const maxDim = Number(argOf("max-dim") ?? 1024);
const minDim = Number(argOf("min-dim") ?? 8);
const losslessMode = (argOf("lossless") ?? "off") === "auto" ? "auto" : false;
const effort = (argOf("effort") ?? "quality") as "fast" | "quality";
const alphaLevels = Number(argOf("alpha-levels") ?? 32) as 8 | 16 | 32;
const csvPath = argOf("csv");
const worstN = Number(argOf("worst") ?? 10);

// ---------------------------------------------------------------------------
// Reference encoder (same init as probe.ts / bench.ts)

async function makeJsquash(): Promise<
  (rgba: Uint8Array, w: number, h: number, q: number) => Promise<Uint8Array>
> {
  const mod = await import("@jsquash/webp/encode.js" as string);
  const wasmPath = join(
    import.meta.dirname, "..", "node_modules", "@jsquash", "webp", "codec", "enc", "webp_enc_simd.wasm",
  );
  const wasm = await WebAssembly.compile(await readFile(wasmPath));
  await mod.init(wasm);
  return async (rgba, width, height, q) => {
    const idata = {
      data: new Uint8ClampedArray(rgba),
      width,
      height,
      colorSpace: "srgb",
    } as ImageData;
    // method 3 = Chromium's canvas configuration (SkWebpEncoder.cpp)
    return new Uint8Array(await mod.default(idata, { quality: q, method: 3 }));
  };
}

// ---------------------------------------------------------------------------
// Image loading

interface Loaded {
  width: number;
  height: number;
  rgba: Uint8Array;
  srcBytes: number;
}

/** Read PNG/JPEG directly; convert .icns via sips first. */
async function loadRgba(path: string): Promise<Loaded | null> {
  let readPath = path;
  let tmpDir: string | null = null;
  try {
    if (extname(path).toLowerCase() === ".icns") {
      tmpDir = await mkdtemp(join(tmpdir(), "swe-icns-"));
      readPath = join(tmpDir, "icon.png");
      await exec("sips", ["-s", "format", "png", path, "--out", readPath]);
    }
    const srcBytes = (await readFile(path)).length;
    let img = sharp(readPath, { limitInputPixels: 1 << 28 }).ensureAlpha();
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < minDim || meta.height < minDim) return null;
    if (maxDim > 0 && Math.max(meta.width, meta.height) > maxDim) {
      img = img.resize(
        meta.width >= meta.height
          ? { width: maxDim, kernel: "lanczos3" }
          : { height: maxDim, kernel: "lanczos3" },
      );
    }
    const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, rgba: new Uint8Array(data), srcBytes };
  } catch {
    return null;
  } finally {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  }
}

async function decodeWebPRgba(webp: Uint8Array): Promise<Uint8Array> {
  // sharp decodes WebP via libvips/libwebp — the reference decoder, in-process.
  const { data } = await sharp(Buffer.from(webp))
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return new Uint8Array(data);
}

// ---------------------------------------------------------------------------

interface Row {
  path: string;
  width: number;
  height: number;
  srcBytes: number;
  slimBytes: number;
  slimVp8: number;
  slimAlph: number;
  libBytes: number;
  libVp8: number;
  libAlph: number;
  slimPsnr: number;
  libPsnr: number;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[i];
}

const raw = await readFile(listPath, "utf8");
const paths = [
  ...new Set(
    raw
      .split("\n")
      .map((l) => l.trim().replace(/^"|"$/g, ""))
      .filter(Boolean),
  ),
];
console.error(`${paths.length} unique paths in list`);

const jsquash = await makeJsquash();
const rows: Row[] = [];
let skipped = 0;

for (let i = 0; i < paths.length && rows.length < limit; i += stride) {
  const path = paths[i];
  const img = await loadRgba(path);
  if (!img) {
    skipped++;
    console.error(`  skip (load): ${path}`);
    continue;
  }
  try {
    const input = { data: img.rgba, width: img.width, height: img.height };
    const slim = encodeWebP(input, { quality, lossless: losslessMode, effort, alphaLevels });
    const lib = await jsquash(img.rgba, img.width, img.height, quality);
    const slimDec = await decodeWebPRgba(slim);
    const libDec = await decodeWebPRgba(lib);
    rows.push({
      path,
      width: img.width,
      height: img.height,
      srcBytes: img.srcBytes,
      slimBytes: slim.length,
      slimVp8: extractChunk(slim, "VP8 ")?.length ?? 0,
      slimAlph: extractChunk(slim, "ALPH")?.length ?? 0,
      libBytes: lib.length,
      libVp8: extractChunk(lib, "VP8 ")?.length ?? 0,
      libAlph: extractChunk(lib, "ALPH")?.length ?? 0,
      slimPsnr: psnrPerChannelAlphaWeighted(img.rgba, slimDec).rgb,
      libPsnr: psnrPerChannelAlphaWeighted(img.rgba, libDec).rgb,
    });
  } catch (e) {
    skipped++;
    console.error(`  skip (encode): ${path} — ${(e as Error).message}`);
    continue;
  }
  if (rows.length % 50 === 0) {
    console.error(`  ${rows.length} evaluated, ${skipped} skipped…`);
  }
}

// ---------------------------------------------------------------------------
// Summary

const finite = rows.filter((r) => Number.isFinite(r.slimPsnr) && Number.isFinite(r.libPsnr));
const deltas = finite.map((r) => r.slimPsnr - r.libPsnr).sort((a, b) => a - b);
const totalSlim = rows.reduce((s, r) => s + r.slimBytes, 0);
const totalLib = rows.reduce((s, r) => s + r.libBytes, 0);
const totalSlimVp8 = rows.reduce((s, r) => s + r.slimVp8, 0);
const totalLibVp8 = rows.reduce((s, r) => s + r.libVp8, 0);
const mean = deltas.length ? deltas.reduce((s, d) => s + d, 0) / deltas.length : NaN;

console.log(
  `\n=== syseval: ${rows.length} files, q=${quality}, lossless=${losslessMode}, effort=${effort} ===`,
);
console.log(`skipped: ${skipped} (unreadable / too small / encode error)`);
console.log(
  `total bytes: slim ${totalSlim} vs libwebp-m3 ${totalLib} ` +
    `(${((totalSlim / totalLib - 1) * 100).toFixed(1)}%)`,
);
console.log(
  `VP8 chunk bytes: slim ${totalSlimVp8} vs libwebp-m3 ${totalLibVp8} ` +
    `(${((totalSlimVp8 / totalLibVp8 - 1) * 100).toFixed(1)}%)`,
);
console.log(
  `PSNR delta (slim − libwebp, dB): mean ${mean.toFixed(2)}, ` +
    `p5 ${percentile(deltas, 5).toFixed(2)}, median ${percentile(deltas, 50).toFixed(2)}, ` +
    `p95 ${percentile(deltas, 95).toFixed(2)} ` +
    `(${finite.length} finite of ${rows.length})`,
);

const short = (p: string) => (p.length > 72 ? "…" + p.slice(-71) : p);

const worstPsnr = [...finite]
  .sort((a, b) => a.slimPsnr - a.libPsnr - (b.slimPsnr - b.libPsnr))
  .slice(0, worstN);
console.log(`\nworst ${worstPsnr.length} by PSNR delta:`);
for (const r of worstPsnr) {
  console.log(
    `  ${(r.slimPsnr - r.libPsnr).toFixed(2).padStart(7)} dB ` +
      `(${r.slimPsnr.toFixed(1)} vs ${r.libPsnr.toFixed(1)}) ${r.width}x${r.height}  ${short(r.path)}`,
  );
}

const worstSize = [...rows]
  .filter((r) => r.libBytes > 0)
  .sort((a, b) => b.slimBytes / b.libBytes - a.slimBytes / a.libBytes)
  .slice(0, worstN);
console.log(`\nworst ${worstSize.length} by size ratio:`);
for (const r of worstSize) {
  console.log(
    `  ${(r.slimBytes / r.libBytes).toFixed(2).padStart(6)}x ` +
      `(${r.slimBytes} vs ${r.libBytes} B) ${r.width}x${r.height}  ${short(r.path)}`,
  );
}

if (csvPath) {
  const header =
    "path,width,height,srcBytes,slimBytes,slimVp8,slimAlph,libBytes,libVp8,libAlph,slimPsnr,libPsnr";
  const lines = rows.map((r) =>
    [
      JSON.stringify(r.path),
      r.width, r.height, r.srcBytes,
      r.slimBytes, r.slimVp8, r.slimAlph,
      r.libBytes, r.libVp8, r.libAlph,
      r.slimPsnr.toFixed(3), r.libPsnr.toFixed(3),
    ].join(","),
  );
  await writeFile(csvPath, [header, ...lines].join("\n") + "\n");
  console.log(`\nwrote ${rows.length} rows to ${csvPath}`);
}
