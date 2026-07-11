# slim-webp-enc

A pure-TypeScript lossy WebP encoder with alpha support — no WASM, no loader complexity, zero runtime dependencies. Motivated by WebKit/Safari's lack of native `canvas.toBlob('image/webp')` support. Not a full libwebp replacement (see the non-goals below), but for typical images it encodes in milliseconds at sizes and quality comparable to the browsers' native encoders.

- **44 KB minified** (16 KB gzip) vs ~200–300 KB for a WASM libwebp build
- Low-double-digit-millisecond encodes at common sizes (256² ≈ 15–25 ms), or ~3× faster with `effort: "fast"` (256² ≈ 4 ms) at some size cost
- Rate-distortion mode selection with 4×4 intra modes (libwebp `method=3` style) — on a 5,000-image macOS system-asset sweep, whole files land at **parity with Chromium's libwebp configuration at ~+1 dB PSNR** (several percent smaller with `alphaLevels: 16`)
- Semi-lossy alpha (32-level reduction, 0/255 pinned exactly) compressed with a built-in mini-VP8L coder — typically **smaller total files than `cwebp -m 0`** on alpha-carrying images

## Usage

```ts
import { encodeWebP, hasNativeWebPEncoder } from "@graysonlang/slim-webp-enc";

// Prefer the native encoder where it exists (everything but WebKit).
// Safari accepts 'image/webp' but silently returns PNG — the helper checks.
if (!(await hasNativeWebPEncoder())) {
  const ctx = canvas.getContext("2d")!;
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const webp: Uint8Array = encodeWebP(imageData, { quality: 80 });
  const blob = new Blob([webp], { type: "image/webp" });
}
```

`data` must be RGBA, i.e. at least `width × height × 4` bytes. `encodeWebP` throws a `RangeError` if the dimensions are non-integer, `< 1`, or `> 16383` (the 14-bit WebP header limit), or if `data` is shorter than that.

### Options

| Option | Default | Notes |
|---|---|---|
| `quality` | `80` | 0–100, same scale as cwebp; default matches the browsers' native WebP encoder default. Follows the HTML canvas rule for invalid values: out-of-range, NaN, and ±Infinity encode at the default, as if omitted |
| `effort` | `"quality"` | Encode-time trade. `"quality"` runs the full rate-distortion mode search with 4×4 intra modes (libwebp method-3 style). `"fast"` picks modes by prediction error alone: ~3× faster (256² ≈ 4 ms) at ~1 dB lower average PSNR for similar average size — and up to ~40% larger on gradient/edge-heavy images, where the mode search matters most |
| `alphaLevels` | `32` | 8 / 16 / 32 semi-lossy alpha levels; 0 and 255 always exact. The default favors smooth gradients (banding is far more visible than the payload delta); use 16/8 to shave alpha bytes on mask-like content |
| `alphaDither` | `1` | Ordered-dither strength 0–1 for the alpha level reduction. Hides banding on smooth alpha gradients at some alpha-payload cost; exact 0/255 pixels never dither. `0` disables |
| `alphaAdaptive` | `true` | Pick alpha level values by Lloyd-Max (like libwebp's `-alpha_q`) instead of a uniform grid. Min/max stay exact; masks with ≤ `alphaLevels` distinct values pass through losslessly |
| `lossless` | `"auto"` | Images with ≤ 256 distinct colors are also encoded losslessly (palette VP8L) and the smaller file wins, so `quality` acts as a floor. `true` forces lossless when representable; `false` disables |

**`quality: 100` is still lossy.** Browsers special-case `canvas.toBlob('image/webp', 1.0)` to fully lossless output; this encoder does not — 100 means the finest lossy quantization (still 4:2:0 chroma). Alpha is independent of `quality` and stays bit-exact whenever the untouched plane compresses no larger than the level-reduced one (typical for smooth masks). For guaranteed pixel-exact output use `lossless: true` (representable up to 256 distinct colors) — or PNG, which WebKit encodes natively.

## Scope

Encodes a single lossy VP8 keyframe (16×16 and 4×4 intra modes selected by rate-distortion score, single segment, flat quantization, adaptive token probabilities) in a RIFF/VP8X/ALPH container. RGB→YUV conversion matches libwebp's import pipeline — gamma-corrected chroma averaging, alpha-weighted on mixed-transparency blocks, and block-local luma smoothing under the mask — so alpha-edge chroma matches what browsers' native encoders produce instead of washing out. Alpha is level-reduced, prediction-filtered, and coded as a minimal VP8L stream (ALPH method 1). Flat-color images (≤ 256 distinct colors) are also tried as palette-based lossless VP8L and the smaller file is kept — `quality` is a floor, never a ceiling. Non-goals: animation, metadata, general-purpose lossless RGB (only the palette subset above), decode, rate control. The lossy core runs *smaller* than `cwebp -m 0` for opaque RGB at matched SSIM; against Chromium's actual configuration (libwebp method 3) the VP8 chunk runs ~20 % larger at ~1 dB better PSNR, with whole files at rough parity once alpha and the lossless path weigh in (the default alpha settings spend a few percent on banding-free gradients; `alphaLevels: 16` trades that back).

## Performance

Median encode times in headless Chrome (Apple Silicon, q80; `node harness/bench-browser.ts`) against the two alternatives: the native `canvas.toBlob('image/webp')` (Chrome only), and WASM libwebp (`@jsquash/webp`, method 0, SIMD) — the apples-to-apples option for browsers without native WebP encoding:

| content | size | ours | native | WASM | ours B | native B | WASM B |
|---|---|---|---|---|---|---|---|
| photo (opaque) | 256² | 24 ms | 2.9 ms | 1.0 ms | 4,550 | 4,152 | 4,374 |
| photo (opaque) | 512² | 68 ms | 9.2 ms | 3.1 ms | 9,512 | 8,444 | 8,840 |
| avatar (alpha) | 256² | 20 ms | 6.4 ms | 2.3 ms | **6,264** | 6,472 | 7,212 |
| avatar (alpha) | 512² | 66 ms | 34 ms | 8.0 ms | 17,046 | 16,976 | 17,800 |
| sprite (lossless path) | 256² | 14 ms | 2.8 ms | 1.2 ms | **814** | 3,538 | 4,530 |
| sprite (lossless path) | 512² | 48 ms | 8.6 ms | 3.9 ms | **1,642** | 6,662 | 9,524 |

Per encode: single- to low-double-digit milliseconds at common sizes — roughly 2–8× native and 10–20× WASM libwebp since the encoder gained rate-distortion mode search and 4×4 intra modes. The trade is the payload: WASM costs a **337 KB download plus ~29 ms compile/init** before the first encode, vs this library's 44 KB bundle with none — and our output is smaller than or at parity with both encoders on the alpha cells (their defaults keep alpha fully lossless; slim's 32-level semi-lossy reduction is the size edge, visually indistinguishable at these sizes), several times smaller on sprite content, within ~13% on opaque photos. Benchmark content is the harness corpus itself (`harness/content.ts`), so these rows measure the same images the quality metrics do. For a page encoding a handful of images the totals are comparable and nothing beats zero payload; sustained bulk encoding is where WASM wins.

## Example app

`demo/` is a side-by-side comparison demo (slim-webp-enc vs the browser's native `canvas.toBlob('image/webp')` vs PNG, with bytes, encode time, and alpha-aware PSNR per cell; drag/drop your own images). Built with [@graysonlang/esp](https://github.com/graysonlang/esp):

```
npm run dev        # watch + dev server + Chrome launch (http://localhost:8000)
npm run build      # one-shot demo build into www/
```

In VS Code, the **Debug in Chrome** launch configuration starts the dev server and attaches the debugger with source maps into `src/` and the app.

## Development

```
npm run harness    # encode corpus → webpinfo → dwebp → PSNR/SSIM   (needs libwebp tools)
npm run compare    # size vs cwebp -m 0 at matched SSIM
npm run size       # 55 KB minified-bundle hard gate
npm run deploy-test # pack the publish artifact, install + smoke it as a consumer
npm run dist       # library build (dist/index.js + declarations)
npm run typecheck
```

`harness/gen-tables.ts` regenerates `src/tables.ts` (bitstream constants per RFC 6386) from a libwebp checkout vendored at `vendor/libwebp`.
