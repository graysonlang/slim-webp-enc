import pluginGlobCopy from '@graysonlang/esp/esbuild-plugin-glob-copy';
import pluginImp from '@graysonlang/esp/esbuild-plugin-imp';
import { runBuild } from '@graysonlang/esp/esbuild-runner';

// getOptions receives (extraArgs, verbose, logger) from runBuild.
// extraArgs contains resolved CLI flags (minify, banner, etc.) plus any unknown
// flags forwarded from the command line as esbuild overrides (e.g. --sourcemap or --no-minify).
// verbose and logger are passed through to plugins that support them.
function getOptions(args, verbose, logger) {
  return {
    assetNames: '[name]',
    bundle: true,
    entryPoints: {
      main: 'demo/main.js',
    },
    format: 'esm',
    loader: {
      '.html': 'file',
    },
    // The demo app builds here; the library distribution lives in dist/ (see
    // scripts/dist.mjs). Keeping them apart means `files: ["dist"]` publishes
    // only the library, never the demo bundle.
    outdir: 'www',
    plugins: [
      pluginGlobCopy({ logger }),
      pluginImp({ logger, verbose }),
    ],
    target: ['esnext'],
    ...args,
  };
}

runBuild(getOptions);
