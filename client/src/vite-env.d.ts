/// <reference types="vite/client" />

/** Set in vite.config.ts: package version and commit. */
declare const __APP_VERSION__: string;

/** Set in vite.config.ts: the commit short hash, the same id the server reports at /api/version. */
declare const __BUILD_ID__: string;
