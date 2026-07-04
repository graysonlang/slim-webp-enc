// Emit the library distribution:
//   - dist/index.js    single minified, dependency-free ESM bundle
//   - dist/*.d.ts      type declarations generated via tsconfig.build.json
// The readable, broken-out modules live upstream in src/. Run with: npm run dist

import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';

const bundle = 'dist/index.js';

const result = await esbuild.build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  minify: true,
  format: 'esm',
  target: ['es2020'],
  platform: 'neutral', // pure arithmetic — no node/browser assumptions
  legalComments: 'none',
  metafile: true,
  outfile: bundle,
});

// Declarations, generated from src/ via tsc (single source — no drift).
execFileSync(process.execPath, ['node_modules/typescript/bin/tsc', '-p', 'tsconfig.build.json'], {
  stdio: 'inherit',
});

const bytes = Object.values(result.metafile.outputs)[0]?.bytes ?? 0;
console.log(`dist: ${bundle} (${(bytes / 1024).toFixed(1)} KB, single file, 0 deps) + generated dist/*.d.ts`);
