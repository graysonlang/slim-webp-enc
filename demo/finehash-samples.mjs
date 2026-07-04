// Procedural demo samples carried over from the sibling finehash repo
// (demo/samples.mjs there; same author/license). They are a good
// cross-section for codec validation: smooth gradients, hard edges, additive
// color, text knockouts, alpha ramps/radials, mid/dark-tone charts.
// The host supplies canvas + ImageData primitives, same contract as
// ./samples.mjs.

export function hsv(h, s, v) {
  const i = Math.floor(h * 6) % 6;
  const f = h * 6 - Math.floor(h * 6);
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  return [[v, t, p], [q, v, p], [p, v, t], [p, q, v], [t, p, v], [v, p, q]][i].map(c => c * 255);
}

// `makeCanvas(w, h) -> { canvas, ctx }` creates a canvas and its 2D context;
// `makeImageData(data, w, h) -> ImageData` wraps a raw RGBA buffer for putImageData.
// Returns `build() -> [{ name, canvas }]`: one rendered canvas per sample, which
// the caller encodes (toDataURL in the browser, toBuffer in Node).
// Lattice value noise for the photographic samples: hash the integer corners
// and blend. Order-independent (no rng stream), so it is deterministic in both
// the browser and Node regardless of evaluation order.
function hash2(ix, iy, seed) {
  let h = (Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 974634407)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function vnoise(x, y, seed) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const tx = x - ix, ty = y - iy;
  const fx = tx * tx * (3 - 2 * tx), fy = ty * ty * (3 - 2 * ty);
  const a = hash2(ix, iy, seed), b = hash2(ix + 1, iy, seed);
  const c = hash2(ix, iy + 1, seed), d = hash2(ix + 1, iy + 1, seed);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Fractal value noise in ~[0, 1): octaves at doubling frequency, halving amplitude.
function fbm(x, y, seed, octaves = 4) {
  let v = 0, amp = 0.5, f = 1;
  for (let o = 0; o < octaves; o++) {
    v += amp * vnoise(x * f, y * f, seed + o);
    amp *= 0.5;
    f *= 2;
  }
  return v;
}

export function createSampleSuite({ makeCanvas, makeImageData }) {
  // Per-pixel sample: fn(u, v, x, y) -> [r, g, b, (a)].
  function makeSample(name, w, h, fn) {
    const data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; ++y) {
      for (let x = 0; x < w; ++x) {
        const px = fn(x / (w - 1), y / (h - 1), x, y);
        const j = (y * w + x) * 4;
        data[j] = px[0];
        data[j + 1] = px[1];
        data[j + 2] = px[2];
        data[j + 3] = px.length > 3 ? px[3] : 255;
      }
    }
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.putImageData(makeImageData(data, w, h), 0, 0);
    return { name, canvas };
  }

  // Like makeSample, but the caller draws with the 2D canvas API (shapes, text,
  // gradients, compositing) - used where a per-pixel function is impractical.
  function makeCanvasSample(name, w, h, draw) {
    const { canvas, ctx } = makeCanvas(w, h);
    draw(ctx, w, h);
    return { name, canvas };
  }

  return function build() {
    const gray = v => [v * 255, v * 255, v * 255];
    const scaled_rgb = (r, g, b, s = 1.0) => [r * 255 * s, g * 255 * s, b * 255 * s];
    return [
      // Three primitives with diffuse shading on transparent: a blue sphere (radial
      // highlight), a red cone (apex-radiating angular gradient), and a flat-shaded
      // green cube in front. Exercises smooth gradients, hard edges, and alpha at
      // once. Geometry traced from a hand-tuned SVG of the 3D.png icon; the sphere/cube
      // fills were Display-P3 there and are converted back to sRGB to match the original
      // asset. The cone uses a plain linear shade rather than the SVG's apex conic.
      makeCanvasSample('3d.png', 256, 256, (ctx) => {
        // Blue sphere (drawn first, partly occluded by the cube).
        const sphere = ctx.createRadialGradient(63, 95, 0, 63, 95, 67);
        sphere.addColorStop(0,        'rgb(207,247,255)');
        sphere.addColorStop(0.258319, 'rgb(138,194,255)');
        sphere.addColorStop(0.491594, 'rgb(86,126,227)');
        sphere.addColorStop(0.686568, 'rgb(56,89,178)');
        sphere.addColorStop(1,        'rgb(31,53,108)');
        ctx.fillStyle = sphere;
        ctx.beginPath();
        ctx.arc(71.5, 101.5, 58.5, 0, Math.PI * 2);
        ctx.fill();

        // Red cone (tip up, curved base) with a left-to-right linear shade - light on
        // the upper-left, darkening to the right - for the matte finish of the original
        // icon. (The SVG's apex conic gradient read as too specular here.)
        const cone = ctx.createLinearGradient(119.5, 0, 241, 0);
        cone.addColorStop(0,    'rgb(255,168,168)');
        cone.addColorStop(0.30, 'rgb(255,150,150)');
        cone.addColorStop(0.55, 'rgb(238,95,95)');
        cone.addColorStop(0.78, 'rgb(185,52,52)');
        cone.addColorStop(1,    'rgb(150,30,30)');
        ctx.fillStyle = cone;
        ctx.beginPath();
        ctx.moveTo(184.5, 11);
        ctx.lineTo(119.5, 122);
        ctx.bezierCurveTo(146, 170, 227, 172, 241, 133.176);
        ctx.closePath();
        ctx.fill();

        // Green cube in front: three flat-shaded faces (top lightest, right darkest).
        const face = (pts, col) => {
          ctx.fillStyle = col;
          ctx.beginPath();
          ctx.moveTo(pts[0][0], pts[0][1]);
          for (let i = 1; i < pts.length; ++i) ctx.lineTo(pts[i][0], pts[i][1]);
          ctx.closePath();
          ctx.fill();
        };
        face([[131.5, 88], [202, 121], [132, 159.5], [60, 119.5]], 'rgb(111,242,78)'); // top
        face([[60.5, 119.5], [132, 159.5], [132, 245], [65.5, 201.5]], 'rgb(78,197,50)'); // left
        face([[132, 159.5], [202, 121], [199, 202.5], [132, 245]], 'rgb(40,101,25)'); // right
      }),

      // Photographic-composition scenes: the codecs keep only low frequencies,
      // so plausible tonal structure and palette is what matters, not detail.

      // Landscape: gradient sky with a sun glow over fBm grass fading into
      // haze at the horizon.
      makeSample('meadow.png', 320, 240, (u, v) => {
        const horizon = 0.58;
        if (v < horizon) {
          const t = v / horizon;
          let r = 70 + 130 * t, g = 120 + 105 * t, b = 205 + 40 * t;
          const d2 = ((u - 0.74) ** 2) + ((v - 0.30) ** 2);
          const glow = Math.exp(-d2 * 55);
          const core = Math.exp(-d2 * 400);
          r += 110 * glow + 80 * core;
          g += 82 * glow + 78 * core;
          b += 38 * glow + 66 * core;
          const cloud = fbm(u * 6, v * 10, 11) * (0.25 + 0.75 * t);
          r += 60 * cloud; g += 55 * cloud; b += 45 * cloud;
          return [r, g, b];
        }
        const d = (v - horizon) / (1 - horizon);
        const n = fbm(u * 9 + 40, v * 14, 7);
        let r = 96 + 60 * n - 35 * d;
        let g = 138 + 70 * n - 40 * d;
        let b = 58 + 40 * n - 20 * d;
        const haze = Math.exp(-d * 7);
        r += (200 - r) * haze; g += (215 - g) * haze; b += (235 - b) * haze;
        return [r, g, b];
      }),

      // Abstract bokeh: overlapping out-of-focus colored lights on a dark
      // field, after the classic defocused-string-lights photograph. Discs
      // accumulate additively like light, blooming toward white where they
      // overlap.
      makeSample('bokeh.png', 300, 200, (() => {
        // [cx, cy, radius, edge softness, R, G, B] in image-height units.
        const lights = [
          [0.55, 0.02, 0.140, 1.6, 60, 60, 230],   // blue, clipped at the top
          [0.70, 0.16, 0.150, 1.4, 190, 25, 35],   // red, upper right
          [0.40, 0.36, 0.150, 1.6, 245, 120, 20],  // orange
          [0.27, 0.50, 0.120, 1.6, 110, 55, 215],  // violet
          [0.52, 0.44, 0.160, 1.6, 235, 60, 120],  // pink
          [0.33, 0.62, 0.115, 1.8, 55, 220, 195],  // cyan
          [0.44, 0.58, 0.110, 1.7, 250, 215, 160], // white-hot core
          [0.55, 0.68, 0.130, 1.6, 240, 150, 40],  // amber
          [0.44, 0.83, 0.130, 1.6, 215, 35, 65],   // crimson, low
          [0.88, 0.46, 0.110, 1.2, 110, 55, 22],   // dim ember, far right
          [0.13, 0.80, 0.070, 1.4, 28, 75, 55],    // faint green fleck
        ];
        return (u, v) => {
          let r = 12, g = 9, b = 10;
          // faint ambient washes in the darkness
          r += 26 * Math.exp(-(((u - 0.08) ** 2) + ((v - 0.16) ** 2)) * 6);
          g += 12 * Math.exp(-(((u - 0.30) ** 2) + ((v - 0.75) ** 2)) * 8);
          for (const [cx, cy, rad, k, lr, lg, lb] of lights) {
            const d = Math.hypot((u - cx) * 1.5, v - cy);
            const s = Math.min(1, Math.max(0, (1 - d / rad) * k));
            r += lr * s; g += lg * s; b += lb * s;
          }
          return [r, g, b];
        };
      })()),

      // Night scene: light-polluted sky and a moon over a dark skyline strewn
      // with warm window lights - exercises dark-tone response.
      makeSample('night.png', 320, 200, (u, v) => {
        const ridge = 0.52 + 0.16 * (fbm(u * 6, 3.7, 21, 3) - 0.47);
        if (v < ridge) {
          const t = v / ridge;
          let r = 8 + 40 * t * t, g = 10 + 34 * t * t, b = 22 + 52 * t * t;
          const md = Math.hypot(u - 0.22, (v - 0.18) * 0.625);
          const moon = Math.min(1, Math.max(0, (0.045 - md) * 90));
          const mglow = Math.exp(-md * 9);
          r += 210 * moon + 30 * mglow;
          g += 212 * moon + 32 * mglow;
          b += 205 * moon + 38 * mglow;
          return [r, g, b];
        }
        const base = 14 + 26 * fbm(u * 8 + 9, v * 8, 33, 3);
        let r = base, g = base * 0.94, b = base * 1.05;
        const win = vnoise(u * 42, v * 30, 55);
        const lit = win > 0.82 ? (win - 0.82) / 0.18 : 0;
        r += 190 * lit; g += 150 * lit; b += 70 * lit;
        const glow = Math.exp(-(1 - v) * 5.5);
        r += 70 * glow; g += 46 * glow; b += 18 * glow;
        return [r, g, b];
      }),

      // RGBA showcase: additive R/G/B circles on transparent, channel letters knocked
      // out to transparent, a 50% orange ALPHA caption, and blurred black/white corner dots.
      makeCanvasSample('rgba.png', 512, 512, (ctx) => {
        const disc = (cx, cy) => {
          ctx.beginPath();
          ctx.arc(cx, cy, 124, 0, Math.PI * 2);
          ctx.fill();
        };
        ctx.fillStyle = '#f00';
        disc(344, 305);
        ctx.globalCompositeOperation = 'lighter';
        ctx.fillStyle = '#0f0';
        disc(168, 305);
        ctx.fillStyle = '#00f';
        disc(256, 153);
        ctx.globalCompositeOperation = 'destination-out';
        ctx.fillStyle = '#000';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.font = 'bold 96px sans-serif';
        ctx.fillText('R', 344, 305);
        ctx.fillText('G', 168, 305);
        ctx.fillText('B', 256, 153);
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = 'rgba(255, 128, 0, 0.75)';
        ctx.font = 'bold 72px sans-serif';
        ctx.fillText('ALPHA', 256, 474);
        const dot = (cx, cy, rgb) => {
          const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, 48);
          grad.addColorStop(0, `rgba(${rgb}, 1)`);
          grad.addColorStop(1, `rgba(${rgb}, 0)`);
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.arc(cx, cy, 48, 0, Math.PI * 2);
          ctx.fill();
        };
        dot(55, 61, '0, 0, 0');
        dot(456, 61, '255, 255, 255');
      }),
      makeSample('fractal.png', 512, 512, (_u, _v, x, y) => {
        const xx = x % 256, yy = y % 256;
        return [(256 - xx + ((xx - 1) & (yy - 1))) & 255, 255 - yy, xx];
      }),
      makeSample('grid-spectrum.png', 512, 512, (u, v, x, y) => {
        if (x < 2 || y < 2 || x >= 510 || y >= 510) return [0, 0, 0];
        if ((x % 32 === 0 || y % 32 === 0) && (x + y) % 2 === 0) return [0, 0, 0];
        return [255 * (1 - u), 255 * v, 255 * u];
      }),
      makeSample('picker.png', 288, 256, (_u, _v, x, y) => {
        if (x >= 256) {
          const t = y / 255;
          const e = t < 0.5 ? 0.5 * Math.pow(2 * t, 1.3) : 1 - 0.5 * Math.pow(2 - 2 * t, 1.3);
          return [255 * e, 255 * e, 255 * e];
        }
        const [hr, hg, hb] = hsv(x / 256, 1, 1);
        const l = y / 255;
        if (l <= 0.5) return [hr * 2 * l, hg * 2 * l, hb * 2 * l];
        const t = 2 * l - 1;
        return [hr + (255 - hr) * t, hg + (255 - hg) * t, hb + (255 - hb) * t];
      }),

      makeSample('hue-sweep.png', 240, 120, u => hsv(u, 0.85, 0.9)),

      // Framed 2x2 checkerboard: off-white border, black rounded frame + divider, with
      // teal/purple cells to exercise high-contrast edges (sizes are approximate).
      makeSample('frame.png', 348, 423, (_u, _v, x, y) => {
        const inRR = (x0, y0, x1, y1, r) => {
          if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
          const nx = Math.min(Math.max(x, x0 + r), x1 - 1 - r);
          const ny = Math.min(Math.max(y, y0 + r), y1 - 1 - r);
          return (x - nx) * (x - nx) + (y - ny) * (y - ny) <= r * r;
        };
        const inR = (x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
        if (!inRR(23, 23, 325, 333, 10)) return [251, 251, 251]; // body 302x310
        const teal = [84, 196, 200], purple = [150, 40, 146];
        if (inR(31, 31, 170, 174) || inR(178, 182, 317, 325)) return teal; // cells 139x143
        if (inR(178, 31, 317, 174) || inR(31, 182, 170, 325)) return purple;
        return [0, 0, 0];
      }),

      // Same frame/border as frame.png but smaller white/gray rectangles inset
      // 35 px from each cell edge instead of full teal/purple fills.
      makeSample('gray-squares.png', 348, 423, (_u, _v, x, y) => {
        const inRR = (x0, y0, x1, y1, r) => {
          if (x < x0 || x >= x1 || y < y0 || y >= y1) return false;
          const nx = Math.min(Math.max(x, x0 + r), x1 - 1 - r);
          const ny = Math.min(Math.max(y, y0 + r), y1 - 1 - r);
          return (x - nx) * (x - nx) + (y - ny) * (y - ny) <= r * r;
        };
        const inR = (x0, y0, x1, y1) => x >= x0 && x < x1 && y >= y0 && y < y1;
        if (!inRR(23, 23, 325, 333, 10)) return [251, 251, 251];
        if (inR(66, 66, 135, 139)) return [255, 255, 255];
        if (inR(213, 66, 282, 139)) return [140, 140, 140];
        if (inR(66, 217, 135, 290)) return [85, 85, 85];
        if (inR(213, 217, 282, 290)) return [255, 255, 255];
        return [0, 0, 0];
      }),

      // 2x2 grid of white/gray squares on black - exercises mid-tone and dark-tone response.
      makeSample('gray-squares2.png', 320, 320, (_u, _v, x, y) => {
        const r = 35;
        const centers = [[80, 80], [240, 80], [80, 240], [240, 240]];
        const colors = [[255, 255, 255], [140, 140, 140], [85, 85, 85], [255, 255, 255]];
        for (let i = 0; i < 4; i++) {
          const [cx, cy] = centers[i];
          if (Math.abs(x - cx) <= r && Math.abs(y - cy) <= r) return colors[i];
        }
        return [0, 0, 0];
      }),

      makeSample('gamma-test.png', 512, 512, (_u, _v, x, y) => {
        const g = x >= 256 ? 128 : (y < 256 ? (((x + y) & 1) ? 0 : 255) : 188);
        return [g, g, g];
      }),

      // 25% red overall, with a half-size centre square at 62.5% (a 50% layer over the 25% base).
      makeSample('red_alpha.png', 512, 512, (_u, _v, x, y) => {
        const center = x >= 128 && x < 384 && y >= 128 && y < 384;
        return [255, 0, 0, center ? 160 : 64];
      }),
      makeSample('alpha-gradient.png', 256, 256, u => [255, 128, 0, (1 - u) * 255]),
      makeSample('radial.png', 256, 256, (u, v) => scaled_rgb(1, 1, 0, Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 1.4))),
      makeSample('alpha-radial.png', 200, 200, (u, v) => [51, 204, 51, Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) * 2) * 255]),

      makeSample('sky.png', 240, 320, (_u, v) => [120 + v * 90, 155 + v * 70, 210 - v * 30]),
      makeSample('sunset.png', 320, 75, (u, v) => [235 - v * 130, 120 - v * 50, 95 + u * 70]),


      makeSample('portrait.png', 240, 320, (u, v) => gray(v)),
      makeSample('landscape.png', 320, 240, u => gray(u)),
      makeSample('wide.png', 320, 75, u => gray((u))),
    ];
  };
}
