import type { ImapFlow } from 'imapflow';
import { setImmediate as nextTick } from 'node:timers/promises';
import type { AccountConfig } from '../types.js';
import { createImapClient, getPooledImapClient } from './imap.js';
import { classifyParts } from './mailparts.js';
import { conversationFolders, resolveFolders, type Folders } from './folders.js';
import type { IndexRow, OrganiseStore } from './organise-store.js';
import { normaliseMsgId, referencesFromHeaderBlock, threadIdFor } from './threading.js';

/**
 * The conversation index (thread id, Message-ID, has-attachments per folder UID) for Inbox, Sent and
 * Archive. The list never waits for it:
 *  - a list call does three STATUS commands and, when only a little new mail arrived (up to
 *    INLINE_TOP_UP_MAX UIDs above the stored high-water mark), indexes it inline;
 *  - everything else (first run, large gaps, UIDVALIDITY changes, pruning moved mail) runs in the
 *    background on its own short-lived IMAP connection, newest first, saving after every batch so an
 *    interrupted run resumes where it stopped.
 */

export const INLINE_TOP_UP_MAX = 200;
const INDEX_FETCH = { uid: true, envelope: true, headers: ['references'], bodyStructure: true };

export interface IndexerOptions {
  batchSize?: number;
  /** Wait after a failed background run before another may start (ms). */
  retryMs?: number;
  /** Test hook: called after each saved batch; throwing simulates a dropped connection. */
  onBatch?: (info: { email: string; folder: string; phase: 'new' | 'backfill'; count: number }) => void | Promise<void>;
  log?: { warn: (o: object, m: string) => void };
  now?: () => number;
}

async function readRows(client: ImapFlow, range: number[] | string, folder: string, uidValidity: string, above = 0): Promise<IndexRow[]> {
  const rows: IndexRow[] = [];
  for await (const msg of client.fetch(range, INDEX_FETCH, { uid: true })) {
    if (msg.uid <= above) continue;
    rows.push({
      uid: msg.uid,
      messageId: normaliseMsgId(msg.envelope?.messageId),
      hasAttachments: classifyParts(msg.bodyStructure).attachments.length > 0,
      threadId: threadIdFor({
        messageId: msg.envelope?.messageId,
        inReplyTo: msg.envelope?.inReplyTo,
        references: referencesFromHeaderBlock(msg.headers),
        fallbackKey: `${folder}:${uidValidity}:${msg.uid}`
      })
    });
  }
  return rows;
}

export class ConversationIndexer {
  private jobs = new Map<string, Promise<void>>();
  private retryAt = new Map<string, number>();
  private batchSize: number;
  private stopped = false;

  constructor(
    private store: OrganiseStore,
    private opts: IndexerOptions = {}
  ) {
    this.batchSize = opts.batchSize ?? 1000;
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /**
   * For a list call: small inline top-up on the session's connection, background work kicked off
   * when more is needed. Returns the mailbox's folders. Never waits on a backfill.
   */
  async refresh(config: AccountConfig): Promise<Folders> {
    const client = await getPooledImapClient(config);
    const folders = await resolveFolders(client);
    let background = false;
    for (const folder of conversationFolders(folders)) {
      const st = await client.status(folder, { uidNext: true, uidValidity: true, messages: true });
      const state = this.store.syncState(config.email, folder);
      if (!state || state.uidValidity !== String(st.uidValidity ?? '')) {
        background = true;
        continue;
      }
      if (!state.complete) background = true;
      const uidNext = Number(st.uidNext ?? 0);
      const gap = uidNext - 1 - state.highUid;
      if (gap > 0 && gap <= INLINE_TOP_UP_MAX) {
        const lock = await client.getMailboxLock(folder, { readOnly: true });
        try {
          const rows = Number(st.messages ?? 0) > 0 ? await readRows(client, `${state.highUid + 1}:*`, folder, state.uidValidity, state.highUid) : [];
          this.store.saveBatch(config.email, folder, rows, { high: uidNext - 1 });
        } finally {
          lock.release();
        }
      } else if (gap > 0) {
        background = true;
      }
      // More rows than messages: mail was moved or deleted; the background run prunes it.
      if (this.store.countFolder(config.email, folder) > Number(st.messages ?? 0)) background = true;
    }
    if (background) this.kick(config);
    return folders;
  }

  /** Start a background run for this mailbox unless one is running or a failed one is cooling off. */
  kick(config: AccountConfig): void {
    const key = config.email.toLowerCase();
    if (this.stopped || this.jobs.has(key) || (this.retryAt.get(key) ?? 0) > this.now()) return;
    const job = this.run({ ...config })
      .then(() => {
        this.retryAt.delete(key);
      })
      .catch((err) => {
        this.retryAt.set(key, this.now() + (this.opts.retryMs ?? 30_000));
        this.opts.log?.warn({ code: 'CONV_INDEX_FAILED', errCode: (err as { code?: string })?.code }, 'Conversation index paused; resumes later');
      })
      .finally(() => this.jobs.delete(key));
    this.jobs.set(key, job);
  }

  /** Resolves when the mailbox's background run (if any) has ended. */
  async idle(email: string): Promise<void> {
    await this.jobs.get(email.toLowerCase());
  }

  /** Server shutdown: no new runs; running ones stop after their current batch. */
  async close(): Promise<void> {
    this.stopped = true;
    await Promise.all([...this.jobs.values()]);
  }

  private checkStopped(): void {
    if (this.stopped) throw Object.assign(new Error('Server is shutting down'), { code: 'SHUTDOWN' });
  }

  running(email: string): boolean {
    return this.jobs.has(email.toLowerCase());
  }

  private async run(config: AccountConfig): Promise<void> {
    const client = createImapClient(config, { disableAutoIdle: true });
    client.on('error', () => undefined);
    await client.connect();
    try {
      const folders = conversationFolders(await resolveFolders(client));
      for (const folder of folders) await this.indexFolder(client, config.email, folder);
    } finally {
      await client.logout().catch(() => undefined);
      client.close();
    }
  }

  private async indexFolder(client: ImapFlow, email: string, folder: string): Promise<void> {
    const mb = await client.mailboxOpen(folder, { readOnly: true });
    const uidValidity = String(mb.uidValidity ?? '');
    const uidNext = Number(mb.uidNext ?? 0);
    const exists = Number(mb.exists ?? 0);
    let state = this.store.syncState(email, folder);
    if (!state || state.uidValidity !== uidValidity) {
      this.store.resetFolder(email, folder, uidValidity, uidNext, exists === 0);
      state = this.store.syncState(email, folder)!;
    }

    // 1. New mail above the high-water mark, in batches.
    if (exists > 0 && uidNext - 1 > state.highUid) {
      const fresh = (((await client.search({ uid: `${state.highUid + 1}:*` }, { uid: true })) || []) as number[])
        .filter((u) => u > state!.highUid)
        .sort((a, b) => a - b);
      for (let i = 0; i < fresh.length; i += this.batchSize) {
        const part = fresh.slice(i, i + this.batchSize);
        this.store.saveBatch(email, folder, await readRows(client, part, folder, uidValidity), { high: part[part.length - 1] });
        await this.opts.onBatch?.({ email, folder, phase: 'new', count: part.length });
        await nextTick();
        this.checkStopped();
      }
    }
    if (uidNext > 0) this.store.saveBatch(email, folder, [], { high: uidNext - 1 });

    // 2. Backfill below the cursor, newest first; each batch saves the cursor with its rows.
    if (!state.complete) {
      const pending =
        state.lowUid > 1 && exists > 0
          ? (((await client.search({ uid: `1:${state.lowUid - 1}` }, { uid: true })) || []) as number[])
              .filter((u) => u < state!.lowUid)
              .sort((a, b) => b - a)
          : [];
      for (let i = 0; i < pending.length; i += this.batchSize) {
        const part = pending.slice(i, i + this.batchSize);
        this.store.saveBatch(email, folder, await readRows(client, part, folder, uidValidity), { low: part[part.length - 1] });
        await this.opts.onBatch?.({ email, folder, phase: 'backfill', count: part.length });
        await nextTick();
        this.checkStopped();
      }
      this.store.saveBatch(email, folder, [], { complete: true });
    }

    // 3. Mail moved or deleted since: one UID SEARCH, then drop the rows whose UID is gone.
    if (this.store.countFolder(email, folder) > exists) {
      const present = new Set(((await client.search({ all: true }, { uid: true })) || []) as number[]);
      this.store.removeFromIndex(email, folder, this.store.indexedUids(email, folder).filter((u) => !present.has(u)));
    }
  }
}
