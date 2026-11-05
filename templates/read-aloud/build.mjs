import { build } from '../../extension/node_modules/esbuild/lib/main.js';
import { fileURLToPath } from 'node:url';
await build({
  absWorkingDir: fileURLToPath(new URL('../../', import.meta.url)),
  entryPoints: [fileURLToPath(new URL('./src/page.js', import.meta.url))],
  outfile: fileURLToPath(new URL('./read-aloud.js', import.meta.url)),
  bundle: true,
  format: 'iife',
  target: ['chrome120', 'safari17'],
  legalComments: 'none',
});
