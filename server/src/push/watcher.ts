import type { ImapFlow } from 'imapflow';
import type { FastifyBaseLogger } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AccountConfig } from '../types.js';
import { createImapClient, isDefinitePasswordRefusal, isPasswordRefused } from '../services/imap.js';
import type { ActiveDevice, PushStore } from './store.js';
import type { PushSendFn } from './sender.js';

/**
 * Watches INBOX of every mailbox that has at least one device with notifications on, and sends
 * Web Push messages for new unread mail.
 *
 * - One IMAP connection per mailbox, shared by all of that person's devices. IMAP IDLE when the
 *   server offers it (with a slow safety poll), otherwise a poll every pollMs (60 s).
 * - New mail is collected and sent as one notification per mailbox at most every collapseMs (30 s),
 *   after a short debounceMs so a burst arriving together becomes one notification with a count.
 * - Payload: "New mail" and a count, unless the device chose "show details" (then sender name and
 *   subject). Never the message body.
 * - A device whose push service answers 404/410 is deleted. A password the mail server refuses
 *   disables every device that stored it (secrets wiped) and tells those devices once.
 * - Only devices of the watched mailbox are ever sent its mail.
 */

export interface WatcherTiming {
  debounceMs: number;
  collapseMs: number;
  /** Poll interval when the server has no IDLE. */
  pollMs: number;
  /** Safety poll interval while IDLE is in use. */
  idlePollMs: number;
  /** First reconnect delay after a dropped connection (doubles up to 5 min). */
  retryMs: number;
  /** Random extra delay (0 to this) before start-up connects and reconnects, so restarts do not stampede the mail server. */
  jitterMs: number;
  /** A refusal without the AUTHENTICATIONFAILED code only counts once a second one comes at least this long after the first. */
  confirmRefusalMs: number;
  /** Test hook: behave as if the mail server had no IDLE (poll every pollMs). */
  noIdle?: boolean;
}

export const DEFAULT_TIMING: WatcherTiming = {
  debounceMs: 3_000,
  collapseMs: 30_000,
  pollMs: 60_000,
  idlePollMs: 5 * 60_000,
  retryMs: 5_000,
  jitterMs: 30_000,
  confirmRefusalMs: 3 * 60_000
};

const MAX_RETRY_MS = 5 * 60_000;

export interface NewMailPayload {
  v: 1;
  kind: 'new-mail';
  mailbox: string;
  title: string;
  body: string;
  count: number;
  unread: number;
  folder: 'INBOX';
  uid: number | null;
  silent: boolean;
  tag: string;
}

export interface PausedPayload {
  v: 1;
  kind: 'paused';
  mailbox: string;
  title: string;
  body: string;
  tag: string;
}

interface Latest {
  uid: number;
  from: string;
  subject: string;
}

/** Strips control and bidi characters and caps length, for text shown on a lock screen. */
function clean(text: string | undefined, max: number): string {
  const s = (text || '').replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩﻿]/g, ' ').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

export function buildNewMailPayload(
  mailbox: string,
  device: { showDetails: boolean; quiet: boolean },
  count: number,
  unread: number,
  latest: Latest | null
): NewMailPayload {
  const countText = count === 1 ? '1 new message' : `${count} new messages`;
  let title = 'New mail';
  let body = countText;
  if (device.showDetails && latest) {
    const from = clean(latest.from, 60) || 'Unknown sender';
    const subject = clean(latest.subject, 120) || '(no subject)';
    if (count === 1) {
      title = from;
      body = subject;
    } else {
      title = countText;
      body = `Latest from ${from}: ${subject}`;
    }
  }
  return {
    v: 1,
    kind: 'new-mail',
    mailbox,
    title,
    body,
    count,
    unread,
    folder: 'INBOX',
    uid: count === 1 && latest ? latest.uid : null,
    silent: device.quiet,
    tag: `mail:${mailbox}`
  };
}

class MailboxWatcher {
  private client: ImapFlow | null = null;
  private stopped = false;
  private connecting = false;
  private lastUid: number | null = null;
  private uidValidity: bigint | null = null;
  private pendingCount = 0;
  private latest: Latest | null = null;
  private lastSentAt = 0;
  private flushTimer: NodeJS.Timeout | null = null;
  private pollTimer: NodeJS.Timeout | null = null;
  private retryTimer: NodeJS.Timeout | null = null;
  private retryDelay: number;
  private queue: Promise<void> = Promise.resolve();
  /** Password the open connection uses. */
  private password: string | null = null;
  /** When the mail server first gave an ambiguous refusal (plain NO) of this password. */
  private refusedSince: { password: string; at: number } | null = null;

  constructor(
    readonly email: string,
    private mgr: PushWatcher
  ) {
    this.retryDelay = mgr.timing.retryMs;
  }

  start(withJitter = false): void {
    const delay = withJitter ? this.jitter() : 0;
    if (delay <= 0) {
      void this.connect();
      return;
    }
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  private jitter(): number {
    return Math.floor(Math.random() * this.mgr.timing.jitterMs);
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  get connected(): boolean {
    return this.client !== null;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const t of [this.flushTimer, this.pollTimer, this.retryTimer]) if (t) clearTimeout(t);
    this.flushTimer = this.pollTimer = this.retryTimer = null;
    const c = this.client;
    this.client = null;
    if (c) {
      await Promise.race([c.logout().catch(() => undefined), new Promise((r) => setTimeout(r, 2000).unref())]);
      c.close();
    }
  }

  private account(password: string): AccountConfig {
    const mail = this.mgr.appConfig.mail;
    return {
      email: this.email,
      imapHost: mail.imapHost,
      imapPort: mail.imapPort,
      imapSecure: mail.imapSecure,
      imapUser: this.email,
      imapPass: password,
      smtpHost: mail.smtpHost,
      smtpPort: mail.smtpPort,
      smtpSecure: mail.smtpSecure,
      tls: { ...mail.tls }
    };
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.retryTimer) return;
    const delay = this.retryDelay + this.jitter();
    this.retryDelay = Math.min(this.retryDelay * 2, MAX_RETRY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.connect();
    }, delay);
    this.retryTimer.unref();
  }

  private async connect(): Promise<void> {
    // One connection at most: a refresh may already have connected before a retry timer fires.
    if (this.stopped || this.connecting || this.client) return;
    this.clearRetry();
    this.connecting = true;
    try {
      for (;;) {
        if (this.stopped) return;
        const devices = this.mgr.store.active(this.email);
        if (devices.length === 0) {
          this.mgr.forget(this);
          return;
        }
        const password = devices[0]!.secrets.password;
        const noIdle = this.mgr.timing.noIdle === true;
        const client = createImapClient(this.account(password), {
          connectionTimeout: 15_000,
          greetingTimeout: 10_000,
          // Dedicated connection: go into IDLE right after each command, restart IDLE every 4 min.
          ...(noIdle ? { disableAutoIdle: true } : { autoIdleDelay: 500, maxIdleTime: 4 * 60_000 })
        });
        client.on('error', () => undefined);
        try {
          await client.connect();
          const mb = await client.mailboxOpen('INBOX');
          if (this.stopped) {
            client.close();
            return;
          }
          const uidNext = Number(mb.uidNext ?? 1);
          if (this.lastUid === null || this.uidValidity !== mb.uidValidity) this.lastUid = uidNext - 1;
          this.uidValidity = mb.uidValidity;
          this.client = client;
          this.password = password;
          this.refusedSince = null;
          this.retryDelay = this.mgr.timing.retryMs;
          client.on('exists', () => this.enqueueCheck());
          client.on('close', () => {
            if (this.client !== client) return;
            this.client = null;
            if (this.pollTimer) clearInterval(this.pollTimer);
            this.pollTimer = null;
            this.scheduleReconnect();
          });
          const idle = client.capabilities.has('IDLE') && !noIdle;
          this.pollTimer = setInterval(() => this.enqueueCheck(), idle ? this.mgr.timing.idlePollMs : this.mgr.timing.pollMs);
          this.pollTimer.unref();
          // Mail that arrived while we were reconnecting.
          this.enqueueCheck();
          // A device changed the stored password while we were connecting: switch over.
          setImmediate(() => {
            if (this.client === client && !this.mgr.store.active(this.email).some((d) => d.secrets.password === password)) void this.refresh();
          });
          return;
        } catch (err) {
          client.close();
          // Only a real "wrong password" answer ends notifications. A temporary failure (for example
          // "[UNAVAILABLE] Temporary authentication failure") is treated as the server being unreachable.
          if (isPasswordRefused(err)) {
            const now = Date.now();
            if (this.refusedSince?.password !== password) this.refusedSince = { password, at: now };
            if (isDefinitePasswordRefusal(err) || now - this.refusedSince.at >= this.mgr.timing.confirmRefusalMs) {
              this.refusedSince = null;
              await this.mgr.disableForPassword(this.email, password, devices);
              continue; // another device may hold a newer password
            }
            this.mgr.log.warn('Push watcher: mail server refused the saved password; will check again before giving up');
            this.scheduleReconnect();
            return;
          }
          this.mgr.log.warn({ code: (err as { code?: string }).code }, 'Push watcher could not reach the mail server; retrying');
          this.scheduleReconnect();
          return;
        }
      }
    } finally {
      this.connecting = false;
    }
  }

  private enqueueCheck(): void {
    this.queue = this.queue.then(() => this.check()).catch(() => undefined);
  }

  private async check(): Promise<void> {
    const client = this.client;
    if (!client || this.stopped || this.lastUid === null) return;
    const found: Latest[] = [];
    let maxUid = this.lastUid;
    for await (const msg of client.fetch(`${this.lastUid + 1}:*`, { uid: true, flags: true, envelope: true }, { uid: true })) {
      if (msg.uid <= this.lastUid) continue; // "n:*" also returns the newest message when nothing is new
      maxUid = Math.max(maxUid, msg.uid);
      if (msg.flags?.has('\\Seen') || msg.flags?.has('\\Deleted')) continue;
      const from = msg.envelope?.from?.[0];
      found.push({ uid: msg.uid, from: from?.name || from?.address || '', subject: msg.envelope?.subject || '' });
    }
    this.lastUid = maxUid;
    if (found.length === 0) return;
    this.pendingCount += found.length;
    this.latest = found.reduce((a, b) => (b.uid > a.uid ? b : a));
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer || this.stopped) return;
    const t = this.mgr.timing;
    const wait = Math.max(t.debounceMs, this.lastSentAt + t.collapseMs - Date.now());
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.queue = this.queue.then(() => this.flush()).catch(() => undefined);
    }, wait);
    this.flushTimer.unref();
  }

  private async flush(): Promise<void> {
    if (this.pendingCount === 0 || this.stopped) return;
    const count = this.pendingCount;
    const latest = this.latest;
    this.pendingCount = 0;
    this.latest = null;
    this.lastSentAt = Date.now();
    let unread = 0;
    try {
      if (this.client) unread = ((await this.client.search({ seen: false, deleted: false }, { uid: true })) || []).length;
    } catch {
      unread = 0;
    }
    await this.mgr.deliver(this.email, (d) => buildNewMailPayload(this.email, d, count, unread, latest));
  }

  /** The connection's password was refused elsewhere, or a device was removed: reconnect with what is left. */
  async refresh(): Promise<void> {
    const devices = this.mgr.store.active(this.email);
    if (devices.length === 0) {
      await this.stop();
      this.mgr.forget(this);
      return;
    }
    // A pending retry must not connect a second time later.
    this.clearRetry();
    if (this.client && devices.some((d) => d.secrets.password === this.password)) return;
    if (this.connecting) return; // the in-flight connect re-checks the password when it finishes
    // The password in use is no longer stored by any device: drop the connection and use a stored one.
    const c = this.client;
    this.client = null;
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    c?.close();
    void this.connect();
  }
}

export class PushWatcher {
  private watchers = new Map<string, MailboxWatcher>();

  constructor(
    readonly store: PushStore,
    readonly send: PushSendFn,
    readonly appConfig: AppConfig,
    readonly log: FastifyBaseLogger,
    readonly timing: WatcherTiming = DEFAULT_TIMING
  ) {}

  /** Starts watchers for every mailbox with a working device (server start). */
  startAll(): void {
    for (const email of this.store.activeMailboxes()) this.ensure(email, true);
  }

  /** Makes sure a mailbox is watched (after a device turned notifications on). */
  ensure(email: string, withJitter = false): void {
    const key = email.toLowerCase();
    const existing = this.watchers.get(key);
    if (existing) {
      void existing.refresh();
      return;
    }
    const w = new MailboxWatcher(key, this);
    this.watchers.set(key, w);
    w.start(withJitter);
  }

  /** After devices were removed: stop the watcher if none are left, or switch password. */
  async refresh(email: string): Promise<void> {
    const w = this.watchers.get(email.toLowerCase());
    if (w) await w.refresh();
  }

  isWatching(email: string): boolean {
    return this.watchers.has(email.toLowerCase());
  }

  /** True once the mailbox's IMAP connection is open and INBOX is selected. */
  isConnected(email: string): boolean {
    return this.watchers.get(email.toLowerCase())?.connected ?? false;
  }

  forget(w: MailboxWatcher): void {
    if (this.watchers.get(w.email) === w) this.watchers.delete(w.email);
  }

  async stopAll(): Promise<void> {
    const all = [...this.watchers.values()];
    this.watchers.clear();
    await Promise.all(all.map((w) => w.stop()));
  }

  /** Sends to every working device of this mailbox (and no other). */
  async deliver(email: string, build: (d: ActiveDevice) => unknown): Promise<void> {
    const devices = this.store.active(email);
    let removed = false;
    await Promise.all(
      devices.map(async (d) => {
        const outcome = await this.send({
          endpoint: d.endpoint,
          p256dh: d.secrets.p256dh,
          auth: d.secrets.auth,
          payload: build(d),
          topic: 'newmail'
        });
        if (outcome === 'gone') {
          this.store.delete(d.id);
          removed = true;
        } else if (outcome === 'ok') this.store.markPushed(d.id);
      })
    );
    // Stop watching once the last device is gone (not awaited: we may be inside the watcher's queue).
    if (removed) void this.refresh(email);
  }

  /** The mail server refused this password: tell each device that stored it, then disable it. */
  async disableForPassword(email: string, password: string, devices: ActiveDevice[]): Promise<void> {
    const affected = devices.filter((d) => d.secrets.password === password);
    await Promise.all(
      affected.map((d) =>
        this.send({
          endpoint: d.endpoint,
          p256dh: d.secrets.p256dh,
          auth: d.secrets.auth,
          payload: {
            v: 1,
            kind: 'paused',
            mailbox: email,
            title: 'Mailloom notifications stopped',
            body: 'The mail server no longer accepts the saved password. Open Mailloom and turn notifications on again.',
            tag: `paused:${email}`
          } satisfies PausedPayload,
          topic: 'paused'
        }).catch(() => 'failed' as const)
      )
    );
    for (const d of affected) this.store.disable(d.id, 'mail server refused the saved password');
    this.log.info({ devices: affected.length }, 'Push devices disabled: mailbox password refused');
  }
}
