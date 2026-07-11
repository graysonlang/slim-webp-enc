// Procedural test patterns for the WebP comparison demo. The avatar, sprite,
// badge, photo, and fade patterns are the harness corpus generators
// themselves (harness/content.ts), so the demo shows exactly the content the
// harness measures; the alpha ramp is demo-only, making level-reduction
// banding easy to eyeball (fade is its noisy real-world cousin). The host
// supplies canvas + ImageData primitives so this module stays free of both
// DOM and Node specifics.

import { GENERATORS, clamp255 } from '../harness/content.ts';

/** Alpha ramp: hue sweep left-to-right under a 0→255 alpha ramp. */
function alphaRamp(w, h) {
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / (w - 1);
      const v = y / (h - 1);
      const i = (y * w + x) * 4;
      px[i] = clamp255(255 * (1 - u));
      px[i + 1] = clamp255(160 * v + 60);
      px[i + 2] = clamp255(255 * u);
      px[i + 3] = clamp255(u * 255);
    }
  }
  return px;
}

// [name, width, height, generator(w, h) -> Uint8Array RGBA]
const SAMPLES = [
  ['avatar', 256, 256, GENERATORS.avatar],
  ['sprite', 256, 256, GENERATORS.sprite],
  ['badge', 256, 256, GENERATORS.flat],
  ['photo', 256, 256, GENERATORS.photo],
  ['alpha-ramp', 256, 128, alphaRamp],
  ['fade', 512, 192, GENERATORS.fade],
];

// Returns build() -> [{ name, canvas }]: one rendered canvas per sample, which
// the caller reads back / encodes as needed.
export function createSampleSuite({ makeCanvas, makeImageData }) {
  function build() {
    return SAMPLES.map(([name, w, h, gen]) => {
      const data = new Uint8ClampedArray(gen(w, h));
      const { canvas, ctx } = makeCanvas(w, h);
      ctx.putImageData(makeImageData(data, w, h), 0, 0);
      return { name, canvas };
    });
  }
  return { build };
}
