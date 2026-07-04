// Procedural test-content generators — the single source of truth shared by
// the corpus writer (harness/corpus.ts), the browser benchmark probe
// (harness/bench-probe.js), and the demo sample suite (demo/samples.mjs).
// Pure per-pixel math with no Node or DOM dependencies. Deterministic (seeded
// PRNG) so results are reproducible across runs and across consumers.
//
// These formulas are the measured baseline behind the harness/compare numbers
// recorded in DESIGN.md — change them and every recorded metric shifts.

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function clamp255(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

export type Generator = (w: number, h: number) => Uint8Array;

/** Photo-like: smooth color field with fine detail and noise. Fully opaque. */
export const photo: Generator = (w, h) => {
  const rng = mulberry32(0xc0ffee);
  const px = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = x / w;
      const v = y / h;
      const base =
        Math.sin(u * 6.1 + Math.sin(v * 4.7) * 2.0) +
        Math.sin(v * 5.3 + Math.sin(u * 3.1) * 1.5);
      const detail = Math.sin(u * 61) * Math.sin(v * 53) * 0.25;
      const n = (rng() - 0.5) * 0.12;
      const i = (y * w + x) * 4;
      px[i] = clamp255((0.5 + 0.35 * Math.sin(base + detail + n)) * 255);
      px[i + 1] = clamp255((0.5 + 0.35 * Math.sin(base * 1.3 + 1.9 + n)) * 255);
      px[i + 2] = clamp255((0.5 + 0.35 * Math.sin(base * 0.7 + 4.0 + detail)) * 255);
      px[i + 3] = 255;
    }
  }
  return px;
};

/** Avatar: circular crop with soft (antialiased, multi-pixel) alpha edge over a gradient face. */
export const avatar: Generator = (w, h) => {
  const px = new Uint8Array(w * h * 4);
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) * 0.46;
  const soft = Math.max(2, Math.min(w, h) * 0.06); // soft edge width in px
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy);
      const a = clamp255(((r - d) / soft + 0.5) * 255);
      const u = x / w;
      const v = y / h;
      const i = (y * w + x) * 4;
      px[i] = clamp255(90 + 130 * u);
      px[i + 1] = clamp255(70 + 110 * v);
      px[i + 2] = clamp255(200 - 120 * u * v);
      px[i + 3] = a;
    }
  }
  return px;
};

/** Flat-color graphic: rounded-rect badge with hard-edged flat regions, transparent corners. */
export const flat: Generator = (w, h) => {
  const px = new Uint8Array(w * h * 4);
  const rad = Math.min(w, h) * 0.18;
  const colors: Array<[number, number, number]> = [
    [235, 64, 52],
    [255, 255, 255],
    [52, 120, 235],
    [46, 174, 82],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // rounded-rect coverage (1px antialiasing only — mostly hard edges)
      const dx = Math.max(rad - x, x - (w - 1 - rad), 0);
      const dy = Math.max(rad - y, y - (h - 1 - rad), 0);
      const d = Math.hypot(dx, dy);
      const a = clamp255((rad - d + 0.5) * 255);
      const band = Math.min(3, Math.floor((y / h) * 4));
      const stripe = Math.floor((x / w) * 8) % 2 === 0 ? 0 : 12;
      const c = colors[band];
      const i = (y * w + x) * 4;
      px[i] = clamp255(c[0] - stripe);
      px[i + 1] = clamp255(c[1] - stripe);
      px[i + 2] = clamp255(c[2] - stripe);
      px[i + 3] = a;
    }
  }
  return px;
};

/** Sprite: fully-transparent background, fully-opaque star + a drop-shadow gradient region. */
export const sprite: Generator = (w, h) => {
  const px = new Uint8Array(w * h * 4); // zero-initialized = fully transparent
  const cx = w / 2;
  const cy = h / 2;
  const rOuter = Math.min(w, h) * 0.42;
  const rInner = rOuter * 0.45;
  const inStar = (x: number, y: number): boolean => {
    const ang = Math.atan2(y - cy, x - cx);
    const d = Math.hypot(x - cx, y - cy);
    const t = ((ang / (2 * Math.PI)) * 5 + 5) % 1;
    const edge = rInner + (rOuter - rInner) * Math.abs(1 - 2 * t);
    return d <= edge;
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      // soft shadow offset down-right
      const sx = x - w * 0.04;
      const sy = y - h * 0.04;
      if (inStar(sx, sy)) {
        px[i] = 20;
        px[i + 1] = 20;
        px[i + 2] = 30;
        px[i + 3] = 90;
      }
      if (inStar(x, y)) {
        px[i] = 250;
        px[i + 1] = 200;
        px[i + 2] = 40;
        px[i + 3] = 255; // fully opaque body
      }
    }
  }
  return px;
};

export const GENERATORS: Record<string, Generator> = { photo, avatar, flat, sprite };
