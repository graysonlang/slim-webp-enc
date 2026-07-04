// Importing index.html (and re-exporting it) makes esbuild emit the page next to
// the bundle and keeps the import from being tree-shaken away.
import index from './index.html';
export function getFilePaths() {
  return { index };
}

// A real consumer would `import ... from '@graysonlang/slim-webp-enc'`; the
// demo imports the local TypeScript source directly so it always tracks src/.
import { encodeWebP, hasNativeWebPEncoder } from '../src/index';

import { createSampleSuite } from './samples.mjs';
import { createSampleSuite as createFinehashSuite } from './finehash-samples.mjs';

const CELL = 160; // longest preview side, px — keep in sync with --cell in index.html
const FULL_MAX = 1024; // cap dropped images so a huge file can't stall the tab

// Use the library's own detection (toBlob-based, hardened against Safari's
// silent PNG fallback) so the demo exercises the shipped API.
const NATIVE_WEBP = await hasNativeWebPEncoder();

const COLUMNS = ['Original', 'slim-webp-enc', ...(NATIVE_WEBP ? ['Native WebP'] : []), 'PNG'];

function el(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of [].concat(children)) {
    node.append(child?.nodeType ? child : document.createTextNode(child ?? ''));
  }
  return node;
}

function ctx2d(canvas, opts = {}) {
  return canvas.getContext('2d', { colorSpace: 'srgb', ...opts });
}

function makeCanvas(w, h) {
  const canvas = el('canvas', { width: w, height: h });
  return { canvas, ctx: ctx2d(canvas) };
}

function makeImageData(data, w, h) {
  return new ImageData(data, w, h, { colorSpace: 'srgb' });
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${src}`));
    img.src = src;
  });
}

function readRgba(canvas) {
  const ctx = ctx2d(canvas, { willReadFrequently: true });
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

function canvasToBlob(canvas, type, quality) {
  return new Promise(resolve => canvas.toBlob(resolve, type, quality));
}

async function blobToCanvas(blob, w, h) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const { canvas, ctx } = makeCanvas(w, h);
    ctx.drawImage(img, 0, 0);
    return canvas;
  } finally {
    URL.revokeObjectURL(url);
  }
}

// PSNR over a checkerboard composite (same metric as the node harness): alpha
// errors show up in RGB instead of being ignored.
function psnrChecker(a, b, w, h) {
  const composite = (px, x, y, i) => {
    const bg = ((x >> 3) + (y >> 3)) % 2 === 0 ? 255 : 190;
    const al = px[i + 3] / 255;
    return [0, 1, 2].map(c => px[i + c] * al + bg * (1 - al));
  };
  let se = 0;
  for (let y = 0; y < h; ++y) {
    for (let x = 0; x < w; ++x) {
      const i = (y * w + x) * 4;
      const ca = composite(a, x, y, i);
      const cb = composite(b, x, y, i);
      for (let c = 0; c < 3; ++c) {
        const d = ca[c] - cb[c];
        se += d * d;
      }
    }
  }
  if (se === 0) return Infinity;
  return 10 * Math.log10((255 * 255) / (se / (w * h * 3)));
}

function fmtBytes(n) {
  return n < 10240 ? `${n} B` : `${(n / 1024).toFixed(1)} KB`;
}

function fmtPsnr(v) {
  return Number.isFinite(v) ? `${v.toFixed(1)} dB` : '∞';
}

function perfBar(bytes, originalBytes) {
  const pct = Math.min(100, (bytes / originalBytes) * 100);
  return el('div', { className: 'perf' }, [
    el('div', { className: 'perf-track' }, [
      el('div', { className: 'perf-fill', style: `width:${pct.toFixed(1)}%` }),
    ]),
    el('div', { className: 'perf-label' }, `${pct.toFixed(1)}% of original`),
  ]);
}

function cell(node, metaHtml, { bytes = null, originalBytes = null, timingHtml = null } = {}) {
  const children = [node, el('div', { className: 'meta', innerHTML: metaHtml })];
  if (bytes != null && originalBytes) children.push(perfBar(bytes, originalBytes));
  if (timingHtml) children.push(el('div', { className: 'meta', innerHTML: timingHtml }));
  return el('div', { className: 'cell' }, children);
}

function preview(canvasOrImg, w, h) {
  const scale = CELL / Math.max(w, h);
  canvasOrImg.style.width = `${Math.max(1, Math.round(w * scale))}px`;
  canvasOrImg.style.height = `${Math.max(1, Math.round(h * scale))}px`;
  return canvasOrImg;
}

async function blobPreview(blob, w, h) {
  const img = el('img', { alt: '' });
  img.src = URL.createObjectURL(blob);
  await new Promise(resolve => { img.onload = resolve; img.onerror = resolve; });
  return preview(img, w, h);
}

const state = {
  quality: 80,
  alphaLevels: 16,
  alphaDither: 1,
  alphaAdaptive: true,
  sources: [], // [{ name, canvas, bytes }]
};

async function encodeSlim(source) {
  const { width, height } = source.canvas;
  const src = readRgba(source.canvas);
  const t0 = performance.now();
  const webp = encodeWebP({ data: src.data, width, height }, {
    quality: state.quality,
    alphaLevels: state.alphaLevels,
    alphaDither: state.alphaDither,
    alphaAdaptive: state.alphaAdaptive,
  });
  const ms = performance.now() - t0;
  const blob = new Blob([webp], { type: 'image/webp' });
  const decoded = readRgba(await blobToCanvas(blob, width, height));
  return { blob, ms, psnr: psnrChecker(src.data, decoded.data, width, height) };
}

async function encodeNative(source, type, quality) {
  const { width, height } = source.canvas;
  const src = readRgba(source.canvas);
  const t0 = performance.now();
  const blob = await canvasToBlob(source.canvas, type, quality);
  const ms = performance.now() - t0;
  if (!blob || (type !== 'image/png' && blob.type !== type)) return null;
  const decoded = readRgba(await blobToCanvas(blob, width, height));
  return { blob, ms, psnr: psnrChecker(src.data, decoded.data, width, height) };
}

async function renderRow(tr, source) {
  const { width: w, height: h } = source.canvas;
  tr.replaceChildren();

  const fmtFactor = (ms, base) => {
    const f = ms / base;
    return `${f >= 10 ? f.toFixed(0) : f.toFixed(1)}× native`;
  };
  const meta = (label, r) =>
    `<b>${label}</b> · ${fmtBytes(r.blob.size)} · PSNR ${fmtPsnr(r.psnr)}`;
  const timing = (r, nativeMs) =>
    `${r.ms.toFixed(1)} ms` + (nativeMs ? ` (${fmtFactor(r.ms, nativeMs)})` : '');

  // Original
  const original = preview(source.canvas, w, h);
  tr.append(el('td', {}, cell(original, `<b>${source.name}</b> · ${w}×${h} · ${fmtBytes(source.bytes)}`)));

  // Native canvas WebP (not on WebKit) — encoded first so our cell can show
  // its encode time as a factor of the native encoder's
  const native = NATIVE_WEBP ? await encodeNative(source, 'image/webp', state.quality / 100) : null;

  // slim-webp-enc
  const slim = await encodeSlim(source);
  tr.append(el('td', {}, cell(
    await blobPreview(slim.blob, w, h),
    meta('WebP', slim),
    { bytes: slim.blob.size, originalBytes: source.bytes, timingHtml: timing(slim, native?.ms) },
  )));

  if (NATIVE_WEBP) {
    tr.append(el('td', {}, native
      ? cell(await blobPreview(native.blob, w, h), meta('WebP', native),
          { bytes: native.blob.size, originalBytes: source.bytes, timingHtml: timing(native) })
      : el('span', { className: 'badge' }, 'unavailable')));
  }

  // PNG baseline
  const png = await encodeNative(source, 'image/png');
  tr.append(el('td', {}, cell(
    await blobPreview(png.blob, w, h),
    meta('PNG', png),
    { bytes: png.blob.size, originalBytes: source.bytes, timingHtml: timing(png) },
  )));
}

let renderGeneration = 0;

async function renderAll() {
  const generation = ++renderGeneration;
  const head = document.getElementById('head-row');
  head.replaceChildren(...COLUMNS.map(c => el('th', {}, c)));

  const tbody = document.getElementById('rows');
  const rows = state.sources.map(() => el('tr'));
  tbody.replaceChildren(...rows);

  const status = document.getElementById('status');
  status.textContent = `encoding at quality ${state.quality}, ${state.alphaLevels} alpha levels…`;
  const t0 = performance.now();
  for (let i = 0; i < state.sources.length; ++i) {
    if (generation !== renderGeneration) return; // superseded by newer render
    await renderRow(rows[i], state.sources[i]);
  }
  status.textContent =
    `${state.sources.length} image(s) · quality ${state.quality} · ${state.alphaLevels} alpha levels · ` +
    `${(performance.now() - t0).toFixed(0)} ms total` +
    (NATIVE_WEBP ? '' : ' · native WebP column omitted (this browser cannot encode WebP)');
  console.log(`[demo-ready] ${status.textContent}`);
}

async function addFiles(files) {
  for (const file of files) {
    if (!file.type.startsWith('image/')) continue;
    const url = URL.createObjectURL(file);
    try {
      const img = await loadImage(url);
      const cap = Math.min(1, FULL_MAX / Math.max(img.naturalWidth, img.naturalHeight));
      const w = Math.max(1, Math.round(img.naturalWidth * cap));
      const h = Math.max(1, Math.round(img.naturalHeight * cap));
      const { canvas, ctx } = makeCanvas(w, h);
      ctx.drawImage(img, 0, 0, w, h);
      state.sources.unshift({ name: file.name, canvas, bytes: file.size });
    } finally {
      URL.revokeObjectURL(url);
    }
  }
  await renderAll();
}

function wireControls() {
  const quality = document.getElementById('quality');
  const qualityLabel = document.getElementById('quality-label');
  quality.addEventListener('input', () => {
    qualityLabel.textContent = quality.value;
  });
  quality.addEventListener('change', () => {
    state.quality = Number(quality.value);
    renderAll();
  });

  document.getElementById('alpha-levels').addEventListener('change', (e) => {
    state.alphaLevels = Number(e.target.value);
    renderAll();
  });

  document.getElementById('alpha-dither').addEventListener('change', (e) => {
    state.alphaDither = e.target.checked ? 1 : 0;
    renderAll();
  });

  document.getElementById('alpha-adaptive').addEventListener('change', (e) => {
    state.alphaAdaptive = e.target.checked;
    renderAll();
  });

  const checkerLabel = document.getElementById('checker-label');
  document.getElementById('checker-toggle').addEventListener('click', () => {
    const light = document.body.classList.toggle('checker-light');
    checkerLabel.textContent = light ? 'light' : 'dark';
  });

  const input = document.getElementById('file-input');
  document.getElementById('upload-btn').addEventListener('click', () => input.click());
  input.addEventListener('change', () => addFiles([...input.files]));

  // Listen on body only — drops anywhere (including the dropzone) bubble up,
  // and a second listener on the dropzone would add every file twice.
  const dropzone = document.getElementById('dropzone');
  document.body.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropzone.classList.add('dragover');
  });
  document.body.addEventListener('dragleave', () => dropzone.classList.remove('dragover'));
  document.body.addEventListener('drop', (e) => {
    e.preventDefault();
    dropzone.classList.remove('dragover');
    addFiles([...e.dataTransfer.files]);
  });
}

async function main() {
  wireControls();
  const host = { makeCanvas, makeImageData };
  const samples = [
    ...createSampleSuite(host).build(),
    ...createFinehashSuite(host)(),
  ];
  for (const { name, canvas } of samples) {
    // PNG size as the "original bytes" reference for procedural samples
    const png = await canvasToBlob(canvas, 'image/png');
    state.sources.push({ name, canvas, bytes: png.size });
  }
  await renderAll();
}

main();
