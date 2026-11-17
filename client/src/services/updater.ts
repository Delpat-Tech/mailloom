/**
 * Picks up a new release in an app that has been left open for days.
 *
 * A fresh open already gets the newest files (the service worker loads the page network first), but code that is
 * already running stays old until the app is closed. So while the app is visible it asks the server which build
 * is running (GET /api/version, a commit short hash) and compares it with the id built into this bundle.
 *
 * When they differ:
 *  - nothing unsaved is open and the user has been idle for a minute (or has just come back to the app):
 *    pending actions and drafts are flushed, then the page reloads;
 *  - something is being edited: the page is never reloaded; a calm bar says "New version ready" and the user
 *    taps Update (drafts are saved first);
 *  - if the version after a reload still differs, it does not reload again (sessionStorage guard) and shows the bar.
 */

/** Asking the server is cheap, but not more often than this. */
export const CHECK_MIN_GAP_MS = 2 * 60_000;
/** While the app stays visible: one more check this often. */
export const CHECK_EVERY_MS = 30 * 60_000;
/** No input for this long counts as idle. */
export const IDLE_MS = 60_000;
/** While an update waits for idleness, look again this often (no network involved). */
export const RECHECK_IDLE_MS = 15_000;
export const GUARD_KEY = 'mailloom.update.reloadedFor';

export type UpdateDecision = 'none' | 'reload' | 'bar';

export interface DecideInput {
  /** The version the server reports, when it differs from this bundle; null when they match. */
  latest: string | null;
  /** The version we already reloaded for in this tab session (the loop guard). */
  reloadedFor: string | null;
  visible: boolean;
  /** An unsaved composer, an open settings form or modal, or a focused text field. */
  busy: boolean;
  idleMs: number;
}

/** What to do about a newer version right now. Pure, so every case can be tested. */
export function decide(i: DecideInput): UpdateDecision {
  if (!i.latest) return 'none';
  if (i.reloadedFor === i.latest) return 'bar'; // reloaded once already and still not current: stop
  if (i.busy) return 'bar';
  if (i.visible && i.idleMs >= IDLE_MS) return 'reload';
  return 'none'; // clean, but the user is in the middle of something: wait for idleness
}

export interface UpdaterEnv {
  /** This bundle's build id. */
  current: string;
  now: () => number;
  isVisible: () => boolean;
  /** The server's build id, or null when it could not be read. */
  fetchVersion: () => Promise<string | null>;
  /** Ask the service worker to look for new files (errors are ignored). */
  updateWorker: () => Promise<void>;
  isBusy: () => boolean;
  lastInputAt: () => number;
  guard: { get: () => string | null; set: (v: string | null) => void };
  reload: () => void;
}

export type UpdateState = 'current' | 'bar';

export class Updater {
  private latest: string | null = null;
  private lastCheck = -Infinity;
  private checking: Promise<void> | null = null;
  private applying = false;
  private beforeReload = new Set<() => Promise<unknown> | unknown>();
  private listeners = new Set<() => void>();
  private idleTimer: ReturnType<typeof setInterval> | undefined;
  private slowTimer: ReturnType<typeof setInterval> | undefined;

  constructor(private readonly env: UpdaterEnv) {
    // A reload that worked: forget the guard.
    if (env.guard.get() && env.guard.get() === env.current) env.guard.set(null);
  }

  /** The bar is showing: a newer version is ready and the page may not reload by itself. */
  get barVisible(): boolean {
    return this.latest !== null && this.decision() === 'bar';
  }

  get updateAvailable(): boolean {
    return this.latest !== null;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  /** Work that must finish before a reload (saving drafts, running pending actions). Returns an unregister function. */
  registerBeforeReload(fn: () => Promise<unknown> | unknown): () => void {
    this.beforeReload.add(fn);
    return () => this.beforeReload.delete(fn);
  }

  private decision(): UpdateDecision {
    const now = this.env.now();
    return decide({
      latest: this.latest,
      reloadedFor: this.env.guard.get(),
      visible: this.env.isVisible(),
      busy: this.env.isBusy(),
      idleMs: now - this.env.lastInputAt()
    });
  }

  /**
   * Looks at the server's version. Without `force`, nothing happens while the app is hidden or when the last
   * check was under two minutes ago. Resolves true when a newer version exists.
   */
  async check(force = false): Promise<boolean> {
    if (!force) {
      if (!this.env.isVisible()) return this.latest !== null;
      if (this.env.now() - this.lastCheck < CHECK_MIN_GAP_MS) return this.latest !== null;
    }
    if (this.checking) {
      await this.checking;
      return this.latest !== null;
    }
    this.lastCheck = this.env.now();
    this.checking = (async () => {
      const [version] = await Promise.all([this.env.fetchVersion().catch(() => null), this.env.updateWorker().catch(() => undefined)]);
      if (version && version !== this.env.current) this.latest = version;
      else if (version) this.latest = null;
    })().finally(() => {
      this.checking = null;
    });
    await this.checking;
    this.evaluate();
    return this.latest !== null;
  }

  /** Acts on the current decision: reloads when it is safe, otherwise lets the bar show. */
  evaluate(): void {
    if (this.latest === null || this.applying) return;
    if (this.decision() === 'reload') void this.apply();
    this.emit();
  }

  /** Flush pending work and drafts, then reload. This is what the Update button does. */
  async apply(): Promise<void> {
    if (this.applying) return;
    this.applying = true;
    try {
      await Promise.allSettled([...this.beforeReload].map((fn) => Promise.resolve().then(fn)));
    } finally {
      // Remember which version this reload is for: if it is still not current afterwards, we do not loop.
      this.env.guard.set(this.latest);
      this.env.reload();
    }
  }

  /** The app became visible or focused. */
  onResume(): void {
    this.startTimers();
    void this.check();
    this.evaluate();
  }

  onHidden(): void {
    this.stopTimers();
  }

  /** Timers run only while the app is visible: no polling in the background. */
  startTimers(): void {
    if (!this.slowTimer) this.slowTimer = setInterval(() => void this.check(), CHECK_EVERY_MS);
    if (!this.idleTimer) this.idleTimer = setInterval(() => this.evaluate(), RECHECK_IDLE_MS);
  }

  stopTimers(): void {
    clearInterval(this.slowTimer);
    clearInterval(this.idleTimer);
    this.slowTimer = undefined;
    this.idleTimer = undefined;
  }

  /** Call when the busy state changed (a composer opened or closed), so the bar and the idle reload follow. */
  refresh(): void {
    this.evaluate();
    this.emit();
  }
}

// ---- the real thing ---------------------------------------------------------------------------

export const BUILD_ID: string = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';

async function fetchServerVersion(): Promise<string | null> {
  try {
    const res = await fetch(`${window.location.pathname.startsWith('/mail') ? '/mail/api' : '/api'}/version`, { cache: 'no-store', credentials: 'omit' });
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    return typeof body.version === 'string' && /^[0-9a-z-]{1,40}$/.test(body.version) ? body.version : null;
  } catch {
    return null;
  }
}

async function updateWorker(): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  await reg?.update();
}

/** A text field has the focus: the user may be mid-sentence. */
export function isEditingText(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  const tag = el.tagName;
  if (tag === 'TEXTAREA') return true;
  if (tag === 'INPUT') {
    const type = (el as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'submit', 'reset', 'range', 'file', 'image'].includes(type);
  }
  return false;
}

let instance: Updater | null = null;
let busyProbe: () => boolean = () => false;

/** The app tells the updater what counts as unsaved work (composer open, settings open, and so on). */
export function setBusyProbe(fn: () => boolean): void {
  busyProbe = fn;
}

/** null in builds without an id (development): there is nothing to compare with. */
export function getUpdater(): Updater | null {
  if (typeof window === 'undefined' || BUILD_ID === 'dev') return null;
  if (!instance) {
    let lastInput = Date.now();
    const touch = () => {
      lastInput = Date.now();
    };
    for (const ev of ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const) {
      window.addEventListener(ev, touch, { capture: true, passive: true });
    }
    instance = new Updater({
      current: BUILD_ID,
      now: Date.now,
      isVisible: () => document.visibilityState !== 'hidden',
      fetchVersion: fetchServerVersion,
      updateWorker,
      isBusy: () => busyProbe() || isEditingText(),
      lastInputAt: () => lastInput,
      guard: {
        get: () => {
          try {
            return window.sessionStorage.getItem(GUARD_KEY);
          } catch {
            return null;
          }
        },
        set: (v) => {
          try {
            if (v === null) window.sessionStorage.removeItem(GUARD_KEY);
            else window.sessionStorage.setItem(GUARD_KEY, v);
          } catch {
            // No sessionStorage: the worst case is one extra reload per version.
          }
        }
      },
      reload: () => window.location.reload()
    });
  }
  return instance;
}

/** Wires visibility, focus and the timers. Call once from the app; returns the cleanup. */
export function startUpdater(): () => void {
  const u = getUpdater();
  if (!u) return () => undefined;
  const onVisibility = () => (document.visibilityState === 'hidden' ? u.onHidden() : u.onResume());
  const onFocus = () => {
    if (document.visibilityState !== 'hidden') u.onResume();
  };
  document.addEventListener('visibilitychange', onVisibility);
  window.addEventListener('focus', onFocus);
  if (document.visibilityState !== 'hidden') u.onResume();
  return () => {
    document.removeEventListener('visibilitychange', onVisibility);
    window.removeEventListener('focus', onFocus);
    u.stopTimers();
  };
}
