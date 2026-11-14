import type { FastifyBaseLogger } from 'fastify';
import type { AccountConfig } from '../types.js';
import type { AppConfig } from '../config.js';
import type { PushStore } from '../push/store.js';
import type { OrganiseStore } from './organise-store.js';
import { isImapAuthError } from './imap.js';
import { wakeDue, type WakeResult } from './organise.js';

/**
 * Wakes snoozed mail. Two ways in:
 *  - a timer (every minute, unref'd) for mailboxes that have a stored login, which the push feature
 *    keeps (encrypted) per device while notifications are on;
 *  - the next signed-in request or sign-in for that mailbox (wakeFor), for everyone else.
 * Without a stored login, mail waits until the person next uses Mailloom (see docs/snooze.md).
 */
export class Snoozer {
  private timer: NodeJS.Timeout | null = null;
  private running = new Map<string, Promise<WakeResult>>();

  constructor(
    private store: OrganiseStore,
    private push: PushStore,
    private appConfig: AppConfig,
    private log: FastifyBaseLogger,
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

  /** One pass over every mailbox with due snoozes that has a stored login. Returns how many were woken. */
  async tick(): Promise<number> {
    let woken = 0;
    for (const email of this.store.dueMailboxes()) {
      const passwords = [...new Set(this.push.active(email).map((d) => d.secrets.password))];
      for (const password of passwords) {
        try {
          woken += (await this.wake(this.accountFor(email, password))).woken;
          break;
        } catch (err) {
          const code = isImapAuthError(err) ? 'SNOOZE_LOGIN_REFUSED' : 'SNOOZE_WAKE_FAILED';
          this.log.warn({ code, errCode: (err as { code?: string })?.code }, 'Snoozed mail could not be woken yet');
          if (!isImapAuthError(err)) break;
        }
      }
    }
    return woken;
  }

  /** Wake this signed-in mailbox's due snoozes, if any. Never throws. */
  async wakeFor(account: AccountConfig): Promise<WakeResult> {
    if (account.isDemo || !this.store.hasDue(account.email)) return { woken: 0, dropped: 0 };
    try {
      return await this.wake(account);
    } catch (err) {
      if (!isImapAuthError(err)) {
        this.log.warn({ code: 'SNOOZE_WAKE_FAILED', errCode: (err as { code?: string })?.code }, 'Snoozed mail could not be woken yet');
      }
      return { woken: 0, dropped: 0 };
    }
  }

  /** One wake-up per mailbox at a time; callers in between share it. */
  private wake(account: AccountConfig): Promise<WakeResult> {
    const key = account.email.toLowerCase();
    const existing = this.running.get(key);
    if (existing) return existing;
    const p = wakeDue(this.store, account, this.log).finally(() => this.running.delete(key));
    this.running.set(key, p);
    return p;
  }
}
