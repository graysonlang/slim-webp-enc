# Design Notes

Rationale for the design decisions behind slim-webp-enc — a pure-TypeScript lossy WebP thumbnail encoder with alpha. What the library does and how to use it is in the [README](README.md); this document records *why* it is built the way it is.

## Architecture

A lossy WebP-with-alpha file is:

```
RIFF ("WEBP")
└── VP8X chunk        — extended-format header, alpha flag, canvas size
└── ALPH chunk        — alpha plane (prediction-filtered, coded as a headerless VP8L stream)
└── "VP8 " chunk      — VP8 intra keyframe (Y'CbCr 4:2:0)
```

Key simplifications in the VP8 core, chosen for the thumbnail use case (≤ 512², typically 96–256px): fixed quality→QP mapping (no rate control), single segment, cheap SAD-based mode decision (à la libwebp `method=0`), adaptive token probabilities, loop-filter strength derived from QP. The mini-VP8L coder used for alpha (and for the palette-lossless path) skips color transforms, color cache, and subresolution entropy images — it keeps only the prediction transform, one set of canonical Huffman codes, and simple LZ77 backward references.

Out of scope by design: animation, ICC/EXIF/XMP metadata, general-purpose lossless RGB (only the ≤ 256-color palette subset), decode support, SIMD, multi-segment quantization, multi-pass / target-size rate control, sharp YUV.

## Key decisions

| Decision | Choice | Rationale |
|---|---|---|
| Alpha compression | Semi-lossy level reduction (default 16 levels, 0/255 pinned exactly) + mini-VP8L | Invisible at thumbnail scale; the ~16-symbol alphabet gives tightly clustered residuals → short Huffman codes and long LZ77 matches, a large compression multiplier |
| Quantize vs filter order | Quantize **before** the prediction filter | Keeps residuals small and consistent |
| Mode search | SAD heuristics, no RD search | 10–25% size penalty acceptable for thumbnails; keeps the encoder small and simple |
| 4×4 luma modes | **Not added** (gate decision, 2026-07-02) | Corpus measured 24.9% overhead vs `cwebp -m 0` at matched SSIM at decision time — inside target. Hard-edge sprite content was +50–75%, but the lossless-palette path covers most of it. Revisit only if real thumbnails show a gap |
| Adaptive token probabilities | Added during quality tuning | Cut corpus overhead 58.7% → 24.9%; ~120 lines, no decoder risk |
| Transparent-area handling | libwebp parity (1.1.0): 2×2 chroma averaging is gamma-corrected and, on mixed-alpha blocks, alpha-weighted; transparent luma is smoothed to the 8×8-block-local visible average and fully transparent 8×8 blocks are flattened (ports of `WebPAccumulateRGBA` + `WebPCleanupTransparentArea`, lossy path only) | The v1.0.0 global-mean fill let masked-out colors bleed into every alpha-edge chroma sample — the "washed-out thumbnails" gap vs Chromium (−2.6 dB blue at q0 on 16×16 thumbs). The port reaches metric-exact q0 parity with libwebp (`harness/probe.ts`). The lossless candidate still encodes untouched pixels so a lossless result round-trips exactly |
| Out-of-range `quality` | HTML canvas rule, scaled to 0–100: omitted, out-of-range, NaN, and ±Infinity all encode at the default 80 (2026-07-05) | slim is a WebKit gap-filler; throwing (or clamping) where every native `toBlob` silently substitutes its default would make the fallback path stricter than the path it replaces — an error surfacing only on Safari, the least-tested environment. slim-only options (`alphaDither` etc.) still validate strictly since no native contract covers them |
| Lossless candidate selection | Palette VP8L raced against lossy; smaller file wins (2026-07-02) | Amends the "no lossless RGB" non-goal for the ≤ 256-color subset only. Flat/sprite content comes out 2–6× smaller *and* pixel-perfect; obviates most of the deferred 4×4-modes work. Quality acts as a floor: lossless only replaces lossy when not larger |
| `quality: 100` semantics | Still lossy — no native-parity lossless switch (2026-07-04) | Browsers special-case `toBlob('image/webp', 1.0)` to full lossless VP8L; matching that requires general lossless RGB (predictor transform, color cache, real LZ77 — roughly +1,000 lines / +6–10 KB), a non-goal. Alpha already races a lossless plane and is typically exact; users needing pixel-exact output on WebKit have PNG |
| Rate control | None — fixed quality→QP | Thumbnails don't need target-size encoding |
| Bit-exactness reference | `cwebp -m 0` + instrumented diffs | Fastest debugging loop during bring-up |

**Note on the overhead figure:** the size comparison (`npm run compare`) disables both the lossless racing and alpha dithering to isolate the lossy VP8 core. Alpha dithering (added after the 4×4 gate decision) must stay out of this measurement: it lowers the composite SSIM without touching the VP8 chunk, which lets the matched-SSIM sweep pair us against a much lower cwebp quality and inflates the apparent overhead (30.3% instead of ~24%, verified 2026-07-04 — VP8 chunks byte-identical either way). Total files with lossless racing enabled are substantially smaller on flat/sprite content than this metric suggests.

## Bit-order hazard

The VP8L bit writer is **LSB-first**, the opposite of the VP8 boolean coder. Both are covered by isolated round-trip unit tests (`harness/booltest.ts`, `harness/vp8ltest.ts`) precisely because silent corruption here was the largest development risk.

## References

- **RFC 6386** — VP8 Data Format and Decoding Guide (bitstream ground truth).
- **WebP Container Specification** — RIFF/VP8X/ALPH chunk layout.
- **WebP Lossless Bitstream Specification** — for the mini-VP8L subset.
- **libwebp sources** — `src/enc/` (esp. `syntax_enc.c`), `src/dsp/enc.c`, `src/enc/alpha_enc.c`. Portions of this library are translated from libwebp; see the third-party notices in [LICENSE.md](LICENSE.md).
