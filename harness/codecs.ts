// Known-good reference codec wrappers: cwebp / dwebp / webpinfo from libwebp.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";

const exec = promisify(execFile);

export interface RawImage {
  width: number;
  height: number;
  rgba: Uint8Array;
}

export async function readPngRGBA(path: string): Promise<RawImage> {
  const { data, info } = await sharp(path)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, rgba: new Uint8Array(data) };
}

/** Encode a PNG file with cwebp. Returns the WebP bytes. */
export async function cwebpEncode(
  pngPath: string,
  opts: { quality?: number; method?: number; exact?: boolean } = {},
): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "swe-"));
  try {
    const out = join(dir, "out.webp");
    const args = [
      "-q", String(opts.quality ?? 75),
      "-m", String(opts.method ?? 0),
    ];
    if (opts.exact ?? true) args.push("-exact"); // hybrid path needs exact RGB
    await exec("cwebp", [...args, pngPath, "-o", out]);
    return new Uint8Array(await readFile(out));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** Decode WebP bytes with dwebp (the known-good decoder). Returns raw RGBA. */
export async function dwebpDecode(webp: Uint8Array): Promise<RawImage> {
  const dir = await mkdtemp(join(tmpdir(), "swe-"));
  try {
    const inPath = join(dir, "in.webp");
    const outPath = join(dir, "out.png");
    await writeFile(inPath, webp);
    await exec("dwebp", [inPath, "-o", outPath]);
    return await readPngRGBA(outPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface WebpInfoResult {
  ok: boolean;
  /** Full webpinfo report — says *where* a malformed file breaks. */
  report: string;
}

/** Structural validation via webpinfo. ok = parses cleanly with no errors/warnings. */
export async function webpInfo(webp: Uint8Array): Promise<WebpInfoResult> {
  const dir = await mkdtemp(join(tmpdir(), "swe-"));
  try {
    const inPath = join(dir, "in.webp");
    await writeFile(inPath, webp);
    try {
      const { stdout } = await exec("webpinfo", [inPath]);
      const ok = /No error detected/i.test(stdout) && !/warning/i.test(stdout);
      return { ok, report: stdout };
    } catch (e: unknown) {
      const err = e as { stdout?: string; stderr?: string; message: string };
      return { ok: false, report: err.stdout || err.stderr || err.message };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
