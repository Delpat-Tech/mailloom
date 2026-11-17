import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

// Shown in Settings > App: the package version and, when built from a git checkout, the commit.
function buildVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };
  let commit = '';
  try {
    commit = execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    // Not a git checkout: the version alone.
  }
  return commit ? `${pkg.version} (${commit})` : pkg.version;
}

// The same id the server reports at /api/version: the commit short hash (scripts/release.mjs passes it in).
function buildId(): string {
  if (process.env.MAILLOOM_BUILD_ID) return process.env.MAILLOOM_BUILD_ID;
  try {
    return execSync('git rev-parse --short=10 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return 'dev';
  }
}

export default defineConfig({
  base: './',
  plugins: [react()],
  define: { __APP_VERSION__: JSON.stringify(buildVersion()), __BUILD_ID__: JSON.stringify(buildId()) },
  server: {
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: false,
      },
    },
  },
});
