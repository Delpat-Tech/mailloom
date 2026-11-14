// Bundles the server (and every dependency) into one file, plus a tiny launcher that checks the Node version.
//   node bundle-server.js [outDir]      default outDir: release/build
// Output: <outDir>/server.mjs (launcher, this is what pm2 runs) and <outDir>/server.bundle.mjs (the server).
// The launcher exists because node:sqlite is imported at the top of the bundle: on a Node that is too old the
// import itself would fail with an unreadable error before any check could run.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const MIN_NODE = '22.13.0';

const LAUNCHER = `// Mailloom launcher. Checks the Node version, then starts the bundled server.
const MIN = '${MIN_NODE}'.split('.').map(Number);
const have = process.versions.node.split('.').map(Number);
const tooOld = have[0] < MIN[0] || (have[0] === MIN[0] && (have[1] < MIN[1] || (have[1] === MIN[1] && have[2] < MIN[2])));
if (tooOld) {
  console.error('Mailloom needs Node.js ${MIN_NODE} or newer (it uses the built-in node:sqlite). This server runs Node ' + process.versions.node + '. Install Node 22 LTS and start again.');
  process.exit(1);
}
await import('./server.bundle.mjs');
`;

export async function bundleServer(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  await esbuild.build({
    entryPoints: ['server/src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'esm',
    outfile: path.join(outDir, 'server.bundle.mjs'),
    // Some dependencies still use require(); give the ESM bundle one.
    banner: { js: "import { createRequire as __createRequire } from 'module';\nconst require = __createRequire(import.meta.url);" },
    logLevel: 'warning'
  });
  fs.writeFileSync(path.join(outDir, 'server.mjs'), LAUNCHER);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const out = process.argv[2] || path.join(path.dirname(fileURLToPath(import.meta.url)), 'release', 'build');
  await bundleServer(out);
  console.log(`Bundled server into ${out}`);
}
