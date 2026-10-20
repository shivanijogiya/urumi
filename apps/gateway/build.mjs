// Bundles the gateway into one ESM file (dist/main.js) so the runtime image needs no node_modules.
import { build } from 'esbuild';

await build({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  sourcemap: false,
  legalComments: 'none',
  // Optional native driver that pg only loads on request; we never use it.
  external: ['pg-native'],
  // Bundled CommonJS deps call require() for Node built-ins; ESM output has no require of its own.
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  logLevel: 'warning',
});
