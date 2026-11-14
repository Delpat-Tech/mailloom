import { request } from './api.js';
import { isPwaInstalled } from './pwa.js';

/**
 * New-mail notifications while Mailloom is closed (Web Push).
 *
 * Per device and mailbox. Turning on asks the browser for permission and a push subscription,
 * and sends it to the server with the mailbox password (the server stores both encrypted so it
 * can watch the inbox while the person is away). Turning off deletes them on the server.
 */

export interface PushDevice {
  id: string;
  label: string;
  show_details: boolean;
  quiet: boolean;
  created_at: string;
  last_push_at: string | null;
  disabled_at: string | null;
  disabled_reason: string | null;
  status: 'on' | 'stopped';
}

export type PushAvailability =
  | 'ok'
  /** iPhone/iPad Safari: only the home-screen app can receive push. */
  | 'ios-needs-install'
  /** No service worker / PushManager / Notification in this browser. */
  | 'unsupported'
  /** Page not on https (push needs a secure context). */
  | 'insecure'
  /** The person blocked notifications for this site. */
  | 'denied';

export function isIos(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent || '';
  // iPadOS 13+ reports itself as a Mac with touch.
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && (navigator.maxTouchPoints || 0) > 1);
}

export function pushAvailability(): PushAvailability {
  if (typeof window === 'undefined') return 'unsupported';
  if (!window.isSecureContext) return 'insecure';
  if (isIos() && !isPwaInstalled()) return 'ios-needs-install';
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

function keyBytes(base64url: string): Uint8Array {
  const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
  const raw = atob((base64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  return x.length === b.length && x.every((v, i) => v === b[i]);
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const existing = await navigator.serviceWorker.getRegistration();
  if (existing) return existing;
  await navigator.serviceWorker.register('./sw.js');
  return navigator.serviceWorker.ready;
}

/** This browser's current push subscription, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (pushAvailability() !== 'ok' && pushAvailability() !== 'denied') return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    return (await reg?.pushManager.getSubscription()) ?? null;
  } catch {
    return null;
  }
}

export const pushApi = {
  config: () => request<{ enabled: boolean; public_key: string | null; max_devices: number }>('/push/config'),
  device: (endpoint: string) => request<{ device: PushDevice | null }>('/push/device', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  devices: () => request<{ devices: PushDevice[] }>('/push/devices'),
  subscribe: (data: { subscription: PushSubscriptionJSON; password: string; show_details: boolean; quiet: boolean; label?: string }) =>
    request<{ device: PushDevice }>('/push/subscribe', { method: 'POST', body: JSON.stringify(data) }),
  update: (id: string, data: { show_details?: boolean; quiet?: boolean }) =>
    request<{ device: PushDevice }>(`/push/devices/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(data) }),
  remove: (id: string) => request<{ deleted: boolean }>(`/push/devices/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  removeAll: () => request<{ deleted: number }>('/push/devices', { method: 'DELETE' }),
  test: (id: string) => request<{ sent: boolean }>(`/push/devices/${encodeURIComponent(id)}/test`, { method: 'POST' })
};

export class PushSetupError extends Error {}

/**
 * Turns notifications on for this device and the active mailbox. Must start from a click
 * (iPhone only shows the permission prompt for a user gesture).
 */
export async function turnOnPush(opts: { publicKey: string; password: string; showDetails: boolean; quiet: boolean }): Promise<PushDevice> {
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new PushSetupError('Notifications are blocked for Mailloom in this browser. Allow them in the browser or phone settings, then try again.');
  }
  const reg = await registration();
  const appKey = keyBytes(opts.publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options.applicationServerKey, appKey)) {
    // Made for another server key (keys were changed): replace it.
    await sub.unsubscribe().catch(() => undefined);
    sub = null;
  }
  if (!sub) {
    try {
      sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: appKey as BufferSource });
    } catch {
      throw new PushSetupError('This browser could not set up notifications. Try again, or use another browser.');
    }
  }
  const { device } = await pushApi.subscribe({
    subscription: sub.toJSON(),
    password: opts.password,
    show_details: opts.showDetails,
    quiet: opts.quiet
  });
  return device;
}

/**
 * Turns notifications off for this device and the active mailbox (server deletes the stored
 * password). The browser subscription is dropped too unless another signed-in account still uses it.
 */
export async function turnOffPush(deviceId: string, otherAccountsOnThisBrowser: number): Promise<void> {
  await pushApi.remove(deviceId);
  if (otherAccountsOnThisBrowser === 0) {
    const sub = await currentSubscription();
    await sub?.unsubscribe().catch(() => undefined);
  }
}

/** Sets the app icon badge (where supported) to the unread count. */
export function setAppBadge(count: number): void {
  const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
  try {
    if (count > 0) void nav.setAppBadge?.(count)?.catch(() => undefined);
    else void nav.clearAppBadge?.()?.catch(() => undefined);
  } catch {
    // Not supported.
  }
}

export interface OpenMessageTarget {
  mailbox: string;
  folder: string;
  uid: number | null;
}

/** Reads (and removes) "#open=..." which the service worker adds when a notification opens the app. */
export function takeOpenTargetFromHash(): OpenMessageTarget | null {
  if (typeof window === 'undefined') return null;
  const m = /^#open=(.+)$/.exec(window.location.hash);
  if (!m) return null;
  history.replaceState(null, '', window.location.pathname + window.location.search);
  try {
    const t = JSON.parse(decodeURIComponent(m[1]!)) as Partial<OpenMessageTarget>;
    if (typeof t.mailbox !== 'string' || typeof t.folder !== 'string') return null;
    return { mailbox: t.mailbox, folder: t.folder, uid: typeof t.uid === 'number' && t.uid > 0 ? t.uid : null };
  } catch {
    return null;
  }
}
