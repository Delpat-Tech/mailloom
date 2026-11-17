// pnpm release: builds the client and the server from source into release/mailloom-<commit>/,
// proves the bundle starts (and refuses to start without secrets), and packs
// release/mailloom-<commit>.tar.gz. Nothing here touches a server.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleServer, MIN_NODE } from '../bundle-server.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sh = process.platform === 'win32';
const step = (m) => console.log(`\n== ${m}`);
const fail = (m) => {
  console.error(`\nRELEASE FAILED: ${m}`);
  process.exit(1);
};

const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim();

const nodeOk = (() => {
  const [a, b] = process.versions.node.split('.').map(Number);
  const [ma, mb] = MIN_NODE.split('.').map(Number);
  return a > ma || (a === ma && b >= mb);
})();
if (!nodeOk) fail(`Node ${MIN_NODE} or newer is needed to build and run Mailloom (this is ${process.versions.node}).`);

let commit;
try {
  commit = git('rev-parse', '--short=10', 'HEAD');
  if (git('status', '--porcelain', '--untracked-files=no')) commit += '-dirty';
} catch {
  fail('Not a git checkout, so the release cannot be named after a commit.');
}
const name = `mailloom-${commit}`;
const relRoot = path.join(root, 'release');
const out = path.join(relRoot, name);
const tarball = path.join(relRoot, `${name}.tar.gz`);

step(`Release ${name}${commit.endsWith('-dirty') ? '  (uncommitted changes: do not deploy this one)' : ''}`);
fs.rmSync(out, { recursive: true, force: true });
fs.rmSync(tarball, { force: true });
fs.mkdirSync(out, { recursive: true });

step('Building the client');
execFileSync('pnpm', ['--filter', 'mailloom-client', 'build'], {
  cwd: root,
  stdio: 'inherit',
  shell: sh,
  env: { ...process.env, MAILLOOM_BUILD_ID: commit } // the same id VERSION carries, so the app can tell when the server moved on
});
fs.cpSync(path.join(root, 'client', 'dist'), path.join(out, 'public'), { recursive: true });

step('Bundling the server');
await bundleServer(out);
fs.copyFileSync(path.join(root, 'deploy', 'ecosystem.config.cjs'), path.join(out, 'ecosystem.config.cjs'));
fs.copyFileSync(path.join(root, 'deploy', '.env.example'), path.join(out, '.env.example'));
fs.writeFileSync(path.join(out, 'VERSION'), `${name}\nbuilt ${new Date().toISOString()}\nnode >= ${MIN_NODE}\n`);

// ---- smoke tests -------------------------------------------------------------------------------
function runServer(env, { waitFor, ms }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: out,
      env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let log = '';
    let done = false;
    let timer;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ...r, log });
    };
    child.stdout.on('data', (d) => (log += d));
    child.stderr.on('data', (d) => (log += d));
    child.on('exit', (code) => finish({ exited: true, code }));
    timer = setTimeout(() => finish({ exited: false, child }), ms);
    if (waitFor) waitFor(() => log).then(() => finish({ exited: false, child }));
  });
}
const freePort = () =>
  new Promise((res) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => res(p));
    });
  });
const stop = (child) =>
  new Promise((res) => {
    child.once('exit', res);
    child.kill();
    setTimeout(res, 3000);
  });

step('Check 1: refuses to start without secrets');
const bare = await runServer({}, { ms: 15000 });
if (!bare.exited || bare.code === 0) {
  if (bare.child) await stop(bare.child);
  fail('The server started with no SESSION_SECRET and no mail settings.\n' + bare.log);
}
if (!/SESSION_SECRET is not set/.test(bare.log)) fail('The server stopped, but not for the missing secret:\n' + bare.log);
console.log('ok: stopped with "SESSION_SECRET is not set"');

step('Check 2: starts with a throwaway configuration (sqlite sessions, web push, static client)');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mailloom-release-'));
try {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const port = await freePort();
  const env = {
    NODE_ENV: 'production',
    HOST: '127.0.0.1',
    PORT: String(port),
    SESSION_SECRET: crypto.randomBytes(32).toString('hex'),
    SESSION_DB_PATH: path.join(tmp, 'sessions.db'),
    MAIL_IMAP_HOST: '127.0.0.1',
    MAIL_SMTP_HOST: '127.0.0.1',
    MAIL_DOMAINS: 'example.test',
    COOKIE_SECURE: 'true',
    TRUST_PROXY: '127.0.0.1',
    VAPID_PUBLIC_KEY: ecdh.getPublicKey().toString('base64url'),
    VAPID_PRIVATE_KEY: ecdh.getPrivateKey().toString('base64url'),
    VAPID_SUBJECT: 'mailto:release-check@example.test',
    MAILLOOM_PUBLIC_URL: 'https://mail.example.test'
  };
  const up = await runServer(env, {
    ms: 20000,
    waitFor: async (getLog) => {
      for (let i = 0; i < 200; i++) {
        if (/Mailloom Webmail Server running/.test(getLog())) return;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
  });
  if (up.exited) fail('The server stopped by itself with a valid configuration:\n' + up.log);
  try {
    const page = await fetch(`http://127.0.0.1:${port}/`);
    const html = await page.text();
    if (page.status !== 200 || !/<div id="root"/.test(html)) fail(`The client page did not load (status ${page.status}).`);
    const me = await fetch(`http://127.0.0.1:${port}/api/auth/me`);
    if (me.status !== 401) fail(`/api/auth/me answered ${me.status}, expected 401 when signed out.`);
  } finally {
    await stop(up.child);
  }
  if (!fs.existsSync(path.join(tmp, 'sessions.db'))) fail('node:sqlite did not create the session database.');
  console.log('ok: served the client, answered the API, created the sqlite session file');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

step('Packing');
// Relative names and cwd: GNU tar reads "D:\..." as a remote host.
execFileSync('tar', ['-czf', `${name}.tar.gz`, name], { cwd: relRoot, stdio: 'inherit' });
const size = (fs.statSync(tarball).size / 1024 / 1024).toFixed(1);
console.log(`\nRelease ready: ${path.relative(root, tarball)} (${size} MB)`);
console.log(`Needs Node ${MIN_NODE} or newer on the server. See docs/deploy.md.`);
