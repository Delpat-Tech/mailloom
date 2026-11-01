import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['server/src/index.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  outfile: 'deploy/server.mjs',
  banner: {
    js: `
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
`
  },
  external: [
    // Node.js built-ins are handled automatically by platform: 'node'
  ]
});

console.log('✓ Successfully bundled server into deploy/server.mjs');
