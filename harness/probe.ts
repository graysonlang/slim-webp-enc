// Parity probe: slim vs libwebp at the exact Chromium canvas configuration.
//
// For each probe image x quality, encodes with slim and with @jsquash/webp at
// method 3 (what Blink ComputeWebpOptions + SkWebpEncoder pass to libwebp for
// canvas.toBlob/toDataURL), then reports VP8/ALPH chunk bytes, alpha-weighted
// per-channel RGB PSNR, and codec-domain Y/U/V plane PSNR (via dwebp -yuv, so
// chroma loss is measured before any YUV->RGB conversion).
//
// This grid is what root-caused the v1.0.0 chroma-collapse gap to
// transparent-pixel preprocessing (see yuv.ts); it stays as the parity
// regression check for the remaining rate gap (B_PRED / RD / segments).
//
//   node harness/probe.ts [--q=0,10,25,50,75,90] [--images=thumb3d,chroma16,...]
//                         [--big] [--dump]
//
// --big adds the 128x128 corpus originals; --dump writes every encoded file
// to out/probe/ for vp8hdr.ts inspection.

import { execFile } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { encodeWebP } from "../src/index.ts";
import { extractChunk } from "../src/container.ts";
import { rgbaToYuv420 } from "../src/yuv.ts";
import { generateCorpus } from "./corpus.ts";

const exec = promisify(execFile);

// ---------------------------------------------------------------------------
// Probe images

interface ProbeImage {
  name: string;
  width: number;
  height: number;
  rgba: Uint8Array;
}

/** 16x16 stand-in for the finehash 3d.png thumb: saturated primaries on transparency. */
function thumb3d(): ProbeImage {
  const w = 16, h = 16;
  const rgba = new Uint8Array(w * h * 4);
  const put = (x: number, y: number, r: number, g: number, b: number) => {
    const i = (y * w + x) * 4;
    rgba[i] = r; rgba[i + 1] = g; rgba[i + 2] = b; rgba[i + 3] = 255;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x - 5, dy = y - 5;
      if (dx * dx + dy * dy <= 16) put(x, y, 40, 80, 230); // blue sphere
      else if (y >= 8 && x >= 8 && x < 14 && y < 14) put(x, y, 60, 200, 70); // green cube
      else if (y >= 8 && x >= 1 && x <= 6 && Math.abs(x - 3.5) <= (y - 7) * 0.6) {
        put(x, y, 230, 50, 40); // red cone
      }
    }
  }
  return { name: "thumb3d", width: w, height: h, rgba };
}

/** Opaque saturated-chroma quadrants on neutral gray — chroma-collapse canary. */
function chroma16(): ProbeImage {
  const w = 16, h = 16;
  const rgba = new Uint8Array(w * h * 4);
  const colors = [
    [220, 30, 30], [30, 180, 40],
    [40, 60, 220], [128, 128, 128],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const c = colors[(y >> 3) * 2 + (x >> 3)];
      const i = (y * w + x) * 4;
      rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = 255;
    }
  }
  return { name: "chroma16", width: w, height: h, rgba };
}

async function corpusThumbs(includeBig: boolean): Promise<ProbeImage[]> {
  const out: ProbeImage[] = [];
  for (const img of generateCorpus()) {
    if (img.width !== 128) continue; // one source size per generator
    const { data, info } = await sharp(Buffer.from(img.rgba), {
      raw: { width: img.width, height: img.height, channels: 4 },
    })
      .resize(16, 16, { kernel: "lanczos3" })
      .raw()
      .toBuffer({ resolveWithObject: true });
    out.push({
      name: img.name.replace("-128x128", "-16"),
      width: info.width,
      height: info.height,
      rgba: new Uint8Array(data),
    });
    if (includeBig) out.push({ ...img, name: img.name.replace("x128", "") });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reference encoder

// @jsquash/webp needs the raw wasm module under Node (same init as bench.ts).
async function makeJsquash(): Promise<(img: ProbeImage, q: number) => Promise<Uint8Array>> {
  const mod = await import("@jsquash/webp/encode.js" as string);
  const wasmPath = join(
    import.meta.dirname, "..", "node_modules", "@jsquash", "webp", "codec", "enc", "webp_enc_simd.wasm",
  );
  const wasm = await WebAssembly.compile(await readFile(wasmPath));
  await mod.init(wasm);
  return async (img, quality) => {
    const idata = {
      data: new Uint8ClampedArray(img.rgba),
      width: img.width,
      height: img.height,
      colorSpace: "srgb",
    } as ImageData;
    // method 3 = Chromium's canvas configuration (SkWebpEncoder.cpp)
    const buf = await mod.default(idata, { quality, method: 3 });
    return new Uint8Array(buf);
  };
}

// ---------------------------------------------------------------------------
// Metrics

/** Alpha-weighted per-channel PSNR over straight (non-composited) RGB. */
function psnrPerChannel(
  src: Uint8Array,
  dec: Uint8Array,
): { r: number; g: number; b: number; rgb: number } {
  const se = [0, 0, 0];
  let wsum = 0;
  for (let i = 0; i < src.length; i += 4) {
    const w = src[i + 3] / 255;
    if (w === 0) continue;
    wsum += w;
    for (let c = 0; c < 3; c++) {
      const d = src[i + c] - dec[i + c];
      se[c] += w * d * d;
    }
  }
  const p = (s: number) => (s === 0 ? Infinity : 10 * Math.log10((255 * 255 * wsum) / s));
  return { r: p(se[0]), g: p(se[1]), b: p(se[2]), rgb: p((se[0] + se[1] + se[2]) / 3) };
}

/** Decode with dwebp to codec-domain I420 planes. */
async function dwebpYuv(
  webp: Uint8Array,
  width: number,
  height: number,
): Promise<{ y: Uint8Array; u: Uint8Array; v: Uint8Array }> {
  const dir = await mkdtemp(join(tmpdir(), "swe-probe-"));
  try {
    const inPath = join(dir, "in.webp");
    const outPath = join(dir, "out.yuv");
    await writeFile(inPath, webp);
    await exec("dwebp", [inPath, "-yuv", "-o", outPath]);
    const raw = new Uint8Array(await readFile(outPath));
    const cw = (width + 1) >> 1;
    const ch = (height + 1) >> 1;
    const ySize = width * height;
    return {
      y: raw.subarray(0, ySize),
      u: raw.subarray(ySize, ySize + cw * ch),
      v: raw.subarray(ySize + cw * ch, ySize + 2 * cw * ch),
    };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function dwebpRgba(webp: Uint8Array): Promise<Uint8Array> {
  const dir = await mkdtemp(join(tmpdir(), "swe-probe-"));
  try {
    const inPath = join(dir, "in.webp");
    const outPath = join(dir, "out.png");
    await writeFile(inPath, webp);
    await exec("dwebp", [inPath, "-o", outPath]);
    const { data } = await sharp(outPath).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return new Uint8Array(data);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Alpha-weighted PSNR of one decoded codec plane vs the source plane
 * (source = slim's own RGB->YUV conversion). Weight for chroma = mean alpha
 * of the 2x2 source block, so transparent-area handling differences don't
 * pollute the number.
 */
function planePsnr(
  srcPlane: Uint8Array,
  srcStride: number,
  decPlane: Uint8Array,
  w: number,
  h: number,
  weights: Float64Array | null, // per plane-pixel, or null for all-1
): number {
  let se = 0;
  let wsum = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const wt = weights ? weights[y * w + x] : 1;
      if (wt === 0) continue;
      const d = srcPlane[y * srcStride + x] - decPlane[y * w + x];
      se += wt * d * d;
      wsum += wt;
    }
  }
  return se === 0 ? Infinity : 10 * Math.log10((255 * 255 * wsum) / se);
}

// ---------------------------------------------------------------------------

function fmtDb(v: number): string {
  return (v === Infinity ? "inf" : v.toFixed(1)).padStart(6);
}

const args = process.argv.slice(2);
const argOf = (k: string) => args.find((a) => a.startsWith(`--${k}=`))?.split("=")[1];
const qualities = (argOf("q") ?? "0,10,25,50,75,90").split(",").map(Number);
const imageFilter = argOf("images")?.split(",");
const dump = args.includes("--dump");

const DUMP_DIR = join(import.meta.dirname, "..", "out", "probe");
if (dump) await mkdir(DUMP_DIR, { recursive: true });

const images: ProbeImage[] = [
  thumb3d(),
  chroma16(),
  ...(await corpusThumbs(args.includes("--big"))),
].filter((i) => !imageFilter || imageFilter.includes(i.name));

const jsquash = await makeJsquash();

const variants = [
  { name: "slim", jsquash: false },
  { name: "libwebp-m3", jsquash: true },
];

console.log(
  `${"image".padEnd(14)}${"q".padStart(4)} ${"variant".padEnd(12)}` +
    `${"VP8".padStart(6)}${"ALPH".padStart(6)}` +
    `${"psnrRGB".padStart(8)}${"R".padStart(6)}${"G".padStart(6)}${"B".padStart(6)}` +
    `${"Y".padStart(7)}${"U".padStart(6)}${"V".padStart(6)}`,
);

for (const img of images) {
  // codec-domain reference planes + alpha weights
  const yuv = rgbaToYuv420(img.rgba, img.width, img.height);
  const cw = (img.width + 1) >> 1;
  const ch = (img.height + 1) >> 1;
  const yW = new Float64Array(img.width * img.height);
  for (let i = 0; i < yW.length; i++) yW[i] = img.rgba[i * 4 + 3] / 255;
  const cWgt = new Float64Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let s = 0;
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = 0; dx < 2; dx++) {
          const sx = Math.min(cx * 2 + dx, img.width - 1);
          const sy = Math.min(cy * 2 + dy, img.height - 1);
          s += img.rgba[(sy * img.width + sx) * 4 + 3] / 255;
        }
      }
      cWgt[cy * cw + cx] = s / 4;
    }
  }

  for (const q of qualities) {
    for (const v of variants) {
      const webp = v.jsquash
        ? await jsquash(img, q)
        : encodeWebP({ data: img.rgba, width: img.width, height: img.height }, {
            quality: q,
            lossless: false,
          });
      const vp8 = extractChunk(webp, "VP8 ")?.length ?? 0;
      const alph = extractChunk(webp, "ALPH")?.length ?? 0;
      const decRgba = await dwebpRgba(webp);
      const pc = psnrPerChannel(img.rgba, decRgba);
      const dec = await dwebpYuv(webp, img.width, img.height);
      const py = planePsnr(yuv.y, yuv.yStride, dec.y, img.width, img.height, yW);
      const pu = planePsnr(yuv.u, yuv.uvStride, dec.u, cw, ch, cWgt);
      const pv = planePsnr(yuv.v, yuv.uvStride, dec.v, cw, ch, cWgt);
      console.log(
        `${img.name.padEnd(14)}${String(q).padStart(4)} ${v.name.padEnd(12)}` +
          `${String(vp8).padStart(6)}${String(alph).padStart(6)}` +
          `${fmtDb(pc.rgb).padStart(8)}${fmtDb(pc.r)}${fmtDb(pc.g)}${fmtDb(pc.b)}` +
          `${fmtDb(py).padStart(7)}${fmtDb(pu)}${fmtDb(pv)}`,
      );
      if (dump) {
        await writeFile(join(DUMP_DIR, `${img.name}-q${q}-${v.name}.webp`), webp);
      }
    }
  }
  console.log();
}
