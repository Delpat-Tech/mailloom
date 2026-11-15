import { request } from './api.js';
import type { AgentScope } from './connections.js';

/** "Connect Mailloom": the consent screen's calls. The screen lives at "#/connect/<request id>". */

export interface ConnectRequest {
  client_name: string;
  /** Free label from the other app (e.g. the organisation name), or null. */
  label: string | null;
  scopes: AgentScope[];
  /** Where the browser goes back to (host only). */
  redirect_host: string;
  expires_at: string;
}

/** The signed request (a long token: payload.signature) from a location hash, or null when it is not a connect link. */
export function parseConnectHash(hash: string): string | null {
  const m = /^#\/connect\/([A-Za-z0-9_.-]{10,2000})\/?$/.exec(hash);
  return m ? m[1]! : null;
}

/** True for an address the screen may send the browser to: https, or http on this computer. */
export function isSafeReturnUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  } catch {
    return false;
  }
}

export const connectApi = {
  getRequest: (id: string, handle: string) =>
    request<ConnectRequest>(`/oauth/requests?request=${encodeURIComponent(id)}`, { account: handle }),
  /** Allow (with the mailbox password and ticked scopes) or Cancel. Answers where to send the browser next. */
  answer: (handle: string, data: { request_id: string; allow: boolean; scopes?: AgentScope[]; password?: string }) =>
    request<{ redirect: string }>('/oauth/consent', { method: 'POST', body: JSON.stringify(data), account: handle })
};
