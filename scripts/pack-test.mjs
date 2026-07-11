// Deploy test: verify the package as a consumer would receive it.
//
//   node scripts/pack-test.mjs
//
// Builds the exact tarball `npm publish` would ship (`npm pack` runs
// prepare -> dist), installs it into a throwaway project, and checks:
//   - the tarball carries dist/ + package metadata and nothing stray
//   - the package imports by name (ESM) and encodes valid WebP
//   - slim-only option validation throws as documented
//   - the bundled type declarations type-check for a strict consumer
//   - (when libwebp tools are on PATH) webpinfo/dwebp accept the output
// Exits non-zero on any failure; safe to run locally before a release.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(repo, 'package.json'), 'utf8'));
const run = (cmd, args, opts = {}) =>
  execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'inherit'], encoding: 'utf8', ...opts });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'swe-pack-test-'));
let failures = 0;
const check = (label, fn) => {
  try {
    fn();
    console.log(`ok   ${label}`);
  } catch (e) {
    failures++;
    console.error(`FAIL ${label}: ${e.message}`);
  }
};

try {
  // --- pack the real artifact (runs prepare -> dist) ---
  const packOut = run('npm', ['pack', '--pack-destination', tmp], { cwd: repo });
  const tarball = path.join(tmp, packOut.trim().split('\n').pop());

  check('tarball contents are dist/ + metadata only', () => {
    const listing = run('tar', ['-tzf', tarball]);
    const entries = listing.trim().split('\n').map((l) => l.replace(/^package\//, ''));
    if (!entries.includes('dist/index.js')) throw new Error('dist/index.js missing');
    if (!entries.includes('dist/index.d.ts')) throw new Error('dist/index.d.ts missing');
    const stray = entries.filter(
      (e) => !e.startsWith('dist/') && !['package.json', 'README.md', 'LICENSE.md'].includes(e),
    );
    if (stray.length) throw new Error(`unexpected files in tarball: ${stray.join(', ')}`);
  });

  // --- install into a clean consumer project ---
  const consumer = path.join(tmp, 'consumer');
  fs.mkdirSync(consumer);
  fs.writeFileSync(
    path.join(consumer, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  run('npm', ['install', '--no-audit', '--no-fund', tarball], { cwd: consumer });

  // --- runtime smoke test through the installed package name ---
  const outWebp = path.join(consumer, 'smoke.webp');
  fs.writeFileSync(
    path.join(consumer, 'smoke.mjs'),
    `
import { encodeWebP, hasNativeWebPEncoder } from ${JSON.stringify(pkg.name)};
import fs from 'node:fs';
if (typeof hasNativeWebPEncoder !== 'function') throw new Error('missing export');
// gradient + alpha ramp: exercises lossy VP8, ALPH, and option plumbing
const w = 64, h = 48;
const px = new Uint8Array(w * h * 4);
for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
  const i = (y * w + x) * 4;
  px[i] = (x * 4) & 255; px[i + 1] = (y * 5) & 255; px[i + 2] = 128;
  px[i + 3] = Math.min(255, x * 8);
}
for (const opts of [{}, { quality: 50 }, { effort: 'fast' }, { alphaLevels: 8, alphaDither: 0 }]) {
  const out = encodeWebP({ data: px, width: w, height: h }, opts);
  const magic = String.fromCharCode(...out.slice(0, 4)) + String.fromCharCode(...out.slice(8, 12));
  if (magic !== 'RIFFWEBP') throw new Error('bad container magic for ' + JSON.stringify(opts));
}
for (const bad of [{ effort: 'turbo' }, { alphaLevels: 20 }, { alphaDither: NaN }]) {
  let threw = false;
  try { encodeWebP({ data: px, width: w, height: h }, bad); } catch { threw = true; }
  if (!threw) throw new Error('validation did not throw for ' + JSON.stringify(bad));
}
fs.writeFileSync(${JSON.stringify(outWebp)}, encodeWebP({ data: px, width: w, height: h }));
console.log('smoke: all encodes + validations ok');
`,
  );
  check('installed package encodes + validates (node ESM import)', () => {
    run('node', ['smoke.mjs'], { cwd: consumer });
  });

  // --- external decoder acceptance, when libwebp tools are available ---
  let haveTools = true;
  try { run('webpinfo', ['-version']); } catch { haveTools = false; }
  if (haveTools) {
    check('webpinfo accepts the output', () => {
      const report = run('webpinfo', [outWebp]);
      if (!/No error detected/i.test(report)) throw new Error('webpinfo reported a problem');
    });
    check('dwebp decodes the output', () => {
      run('dwebp', [outWebp, '-o', path.join(tmp, 'smoke.png')]);
    });
  } else {
    console.log('skip webpinfo/dwebp (libwebp tools not on PATH)');
  }

  // --- type declarations under a strict consumer ---
  fs.writeFileSync(
    path.join(consumer, 'consumer.ts'),
    `
import { encodeWebP, hasNativeWebPEncoder, type EncodeOptions } from ${JSON.stringify(pkg.name)};
const opts: EncodeOptions = { quality: 80, effort: 'quality', alphaLevels: 32, lossless: 'auto' };
const out: Uint8Array = encodeWebP({ data: new Uint8Array(4), width: 1, height: 1 }, opts);
const probe: Promise<boolean> = hasNativeWebPEncoder();
void out; void probe;
`,
  );
  fs.writeFileSync(
    path.join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        noEmit: true,
        skipLibCheck: false,
      },
      include: ['consumer.ts'],
    }),
  );
  check('type declarations pass strict tsc', () => {
    run(path.join(repo, 'node_modules', '.bin', 'tsc'), ['-p', '.'], { cwd: consumer });
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

if (failures) {
  console.error(`\n${failures} deploy-test failure(s)`);
  process.exit(1);
}
console.log('\ndeploy test: package is publishable');
