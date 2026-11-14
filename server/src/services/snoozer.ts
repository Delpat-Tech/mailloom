import type { FastifyBaseLogger } from 'fastify';
import type { AccountConfig } from '../types.js';
import type { AppConfig } from '../config.js';
import type { PushStore } from '../push/store.js';
import type { OrganiseStore } from './organise-store.js';
import { isImapAuthError } from './imap.js';
import { wakeDue, type WakeResult } from './organise.js';

/** After 1, 2, 3, 4+ failed wake-ups in a row, wait this long before trying that mailbox again. */
export const WAKE_BACKOFF_MS = [1, 5, 15, 60].map((m) => m * 60_000);

/**
 * Wakes snoozed mail. Two ways in:
 *  - a timer (every minute, unref'd) for mailboxes that have a stored login, which the push feature
 *    keeps (encrypted) per device while notifications are on;
 *  - the next signed-in request or sign-in for that mailbox (wakeFor), for everyone else.
 * Without a stored login, mail waits until the person next uses Mailloom (see docs/organise.md).
 * A mailbox whose wake-up keeps failing backs off (1, 5, 15, then 60 minutes), so a broken mailbox
 * does not cost an IMAP round trip on every request.
 */
export class Snoozer {
  private timer: NodeJS.Timeout | null = null;
  private running = new Map<string, Promise<WakeResult>>();
  private failures = new Map<string, { count: number; nextAt: number }>();

  constructor(
    private store: OrganiseStore,
    private push: PushStore,
    private appConfig: AppConfig,
    private log: FastifyBaseLogger,
    private now: () => number = Date.now,
    private intervalMs = 60_000
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private accountFor(email: string, password: string): AccountConfig {
    const mail = this.appConfig.mail;
    return {
      email,
      imapHost: mail.imapHost,
      imapPort: mail.imapPort,
      imapSecure: mail.imapSecure,
      imapUser: email,
      imapPass: password,
      smtpHost: mail.smtpHost,
      smtpPort: mail.smtpPort,
      smtpSecure: mail.smtpSecure,
      tls: { ...mail.tls }
    };
  }

  /** True while this mailbox is backing off after failed wake-ups. */
  coolingOff(email: string): boolean {
    return (this.failures.get(email.toLowerCase())?.nextAt ?? 0) > this.now();
  }

  private failed(email: string, err: unknown): void {
    const key = email.toLowerCase();
    const count = (this.failures.get(key)?.count ?? 0) + 1;
    const wait = WAKE_BACKOFF_MS[Math.min(count, WAKE_BACKOFF_MS.length) - 1]!;
    this.failures.set(key, { count, nextAt: this.now() + wait });
    const code = isImapAuthError(err) ? 'SNOOZE_LOGIN_REFUSED' : 'SNOOZE_WAKE_FAILED';
    this.log.warn({ code, attempt: count, retryInMin: wait / 60_000, errCode: (err as { code?: string })?.code }, 'Snoozed mail could not be woken yet');
  }

  /** One pass over every mailbox with due snoozes that has a stored login. Returns how many were woken. */
  async tick(): Promise<number> {
    let woken = 0;
    for (const email of this.store.dueMailboxes()) {
      if (this.coolingOff(email)) continue;
      const passwords = [...new Set(this.push.active(email).map((d) => d.secrets.password))];
      let lastErr: unknown = null;
      for (const password of passwords) {
        try {
          woken += (await this.wake(this.accountFor(email, password))).woken;
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          if (!isImapAuthError(err)) break;
        }
      }
      if (lastErr) this.failed(email, lastErr);
    }
    return woken;
  }

  /** Wake this signed-in mailbox's due snoozes, if any and not backing off. Never throws. */
  async wakeFor(account: AccountConfig): Promise<WakeResult> {
    if (account.isDemo || this.coolingOff(account.email) || !this.store.hasDue(account.email)) return { woken: 0, dropped: 0 };
    try {
      return await this.wake(account);
    } catch (err) {
      this.failed(account.email, err);
      return { woken: 0, dropped: 0 };
    }
  }

  /** One wake-up per mailbox at a time; callers in between share it. Success clears the back-off. */
  private wake(account: AccountConfig): Promise<WakeResult> {
    const key = account.email.toLowerCase();
    const existing = this.running.get(key);
    if (existing) return existing;
    const p = wakeDue(this.store, account, this.log)
      .then((r) => {
        this.failures.delete(key);
        return r;
      })
      .finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }
}
