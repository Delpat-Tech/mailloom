import { generateRequestDetails } from 'web-push';
import type { PushConfig } from './config.js';

/**
 * Sends one encrypted Web Push message (RFC 8030 / 8291 / 8292). web-push builds the encrypted body
 * and VAPID headers; the request itself goes out with fetch so it has a timeout and never follows
 * redirects.
 */

export type SendOutcome = 'ok' | 'gone' | 'failed';

export interface PushMessage {
  endpoint: string;
  p256dh: string;
  auth: string;
  payload: unknown;
  /** Replaces an undelivered message with the same topic at the push service. */
  topic?: string;
}

export type PushSendFn = (msg: PushMessage) => Promise<SendOutcome>;

const TTL_SECONDS = 6 * 3600;

export function createPushSender(config: PushConfig): PushSendFn {
  return async (msg) => {
    let details;
    try {
      details = generateRequestDetails(
        { endpoint: msg.endpoint, keys: { p256dh: msg.p256dh, auth: msg.auth } },
        JSON.stringify(msg.payload),
        {
          vapidDetails: { subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey },
          TTL: TTL_SECONDS,
          urgency: 'normal',
          contentEncoding: 'aes128gcm',
          ...(msg.topic ? { topic: msg.topic } : {})
        }
      );
    } catch {
      // Malformed keys from the browser: this subscription can never work.
      return 'gone';
    }
    try {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(details.headers)) headers[k] = String(v);
      delete headers['Content-Length'];
      const res = await fetch(details.endpoint, {
        method: 'POST',
        headers,
        body: details.body ? new Uint8Array(details.body) : undefined,
        redirect: 'manual',
        signal: AbortSignal.timeout(10_000)
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.status === 404 || res.status === 410) return 'gone';
      return res.ok ? 'ok' : 'failed';
    } catch {
      return 'failed';
    }
  };
}
