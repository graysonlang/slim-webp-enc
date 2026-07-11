// Build a real-world evaluation corpus from macOS system image assets.
//
//   node harness/syscorpus.ts [--dest=~/Desktop/corpus] [--roots=/System/Library]
//                             [--limit=N] [--min-dim=8]
//
// Scans the given roots for PNG/JPEG/ICNS, dedupes by content hash (system
// assets repeat heavily across .lproj localization bundles), converts .icns
// to PNG via `sips` (largest representation), and copies everything into
//
//   <dest>/<alpha|opaque>/<size-bucket>/<basename>-<hash8>.<ext>
//
// where `alpha` means the image actually uses transparency (alpha channel
// present AND any pixel < 255 — checked via sharp stats, not just the
// header) and size buckets are by longest side: tiny (<16), small (<64),
// medium (<256), large (<1024), huge (>=1024).
//
// Also writes:
//   <dest>/manifest.csv  — corpus file -> original path, dims, alpha, bytes
//   <dest>/list.txt      — all corpus file paths, ready for syseval.ts --list
//
// This is machine-local by design and does not touch the repo's generated
// corpus/ directory (which the CI gates depend on).

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";

const exec = promisify(execFile);

const args = process.argv.slice(2);
const argOf = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const dest = (argOf("dest") ?? join(homedir(), "Desktop", "corpus")).replace(/^~/, homedir());
const roots = (argOf("roots") ?? "/System/Library").split(",");
const limit = Number(argOf("limit") ?? Infinity);
const minDim = Number(argOf("min-dim") ?? 8);

const BUCKETS: Array<[number, string]> = [
  [16, "tiny"],
  [64, "small"],
  [256, "medium"],
  [1024, "large"],
  [Infinity, "huge"],
];
const bucketOf = (maxSide: number) => BUCKETS.find(([lim]) => maxSide < lim)![1];

/** Sanitize a basename for the corpus: strip extension, tame exotic chars. */
function safeName(path: string): string {
  const base = basename(path, extname(path));
  return base.replace(/[^\w@.+-]+/g, "_").slice(0, 64) || "image";
}

// ---------------------------------------------------------------------------

console.error(`scanning ${roots.join(", ")} …`);
const { stdout } = await exec(
  "/usr/bin/find",
  [
    ...roots,
    "-type", "f",
    "(", "-iname", "*.png", "-o", "-iname", "*.jpg", "-o", "-iname", "*.jpeg",
    "-o", "-iname", "*.icns", ")",
  ],
  { maxBuffer: 64 * 1024 * 1024 },
).catch((e) => ({ stdout: (e.stdout as string) ?? "" })); // find exits 1 on unreadable dirs
const found = stdout.split("\n").filter(Boolean);
console.error(`${found.length} files found`);

await mkdir(dest, { recursive: true });
const tmpBase = await mkdtemp(join(tmpdir(), "swe-syscorpus-"));

const seen = new Set<string>();
const manifest: string[] = ["corpusPath,originalPath,width,height,alpha,srcFormat,bytes"];
const listLines: string[] = [];
const counts = new Map<string, number>();
let duplicates = 0;
let skipped = 0;
let copied = 0;
let copiedBytes = 0;

for (const path of found) {
  if (copied >= limit) break;
  try {
    const bytes = await readFile(path);
    const hash = createHash("sha1").update(bytes).digest("hex");
    if (seen.has(hash)) {
      duplicates++;
      continue;
    }
    seen.add(hash);

    // .icns -> PNG (sips picks the largest representation)
    const isIcns = extname(path).toLowerCase() === ".icns";
    let srcPath = path;
    let outExt = extname(path).toLowerCase().replace("jpeg", "jpg") || ".png";
    if (isIcns) {
      srcPath = join(tmpBase, "icon.png");
      await exec("sips", ["-s", "format", "png", path, "--out", srcPath]);
      outExt = ".png";
    }

    const img = sharp(srcPath, { limitInputPixels: 1 << 28 });
    const meta = await img.metadata();
    if (!meta.width || !meta.height || meta.width < minDim || meta.height < minDim) {
      skipped++;
      continue;
    }
    // "alpha" = actually used, not merely declared in the header
    let hasAlpha = false;
    if (meta.hasAlpha) {
      const stats = await img.stats();
      const a = stats.channels[stats.channels.length - 1];
      hasAlpha = a.min < 255;
    }

    const bucket = bucketOf(Math.max(meta.width, meta.height));
    const category = join(hasAlpha ? "alpha" : "opaque", bucket);
    const dir = join(dest, category);
    await mkdir(dir, { recursive: true });
    const outPath = join(dir, `${safeName(path)}-${hash.slice(0, 8)}${outExt}`);
    if (isIcns) {
      await rename(srcPath, outPath).catch(() => copyFile(srcPath, outPath));
    } else {
      await copyFile(path, outPath);
    }

    manifest.push(
      [
        JSON.stringify(outPath),
        JSON.stringify(path),
        meta.width,
        meta.height,
        hasAlpha ? 1 : 0,
        isIcns ? "icns" : (meta.format ?? "unknown"),
        bytes.length,
      ].join(","),
    );
    listLines.push(outPath);
    counts.set(category, (counts.get(category) ?? 0) + 1);
    copied++;
    copiedBytes += bytes.length;
    if (copied % 250 === 0) {
      console.error(`  ${copied} copied, ${duplicates} duplicates, ${skipped} skipped…`);
    }
  } catch {
    skipped++;
  }
}

await rm(tmpBase, { recursive: true, force: true });
await writeFile(join(dest, "manifest.csv"), manifest.join("\n") + "\n");
await writeFile(join(dest, "list.txt"), listLines.join("\n") + "\n");

console.log(`\n=== syscorpus: ${dest} ===`);
console.log(
  `${copied} unique images (${(copiedBytes / 1024 / 1024).toFixed(1)} MB source bytes), ` +
    `${duplicates} duplicates collapsed, ${skipped} skipped`,
);
for (const [category, n] of [...counts.entries()].sort()) {
  console.log(`  ${category.padEnd(16)} ${n}`);
}
console.log(`\nnext: node harness/syseval.ts --list=${join(dest, "list.txt")} --q=75`);
