import { request } from './api';

/** Per-mailbox settings stored on the server so they follow the person across devices. */
export interface AccountTemplate {
  id: string;
  name: string;
  subject: string;
  html: string;
}

export interface AccountSettings {
  version: number;
  loadPictures: boolean;
  signature: { html: string; logo: string | null };
  templates: AccountTemplate[];
  theme: 'system' | 'light' | 'dark';
  defaultReply: 'reply' | 'replyAll';
}

/** The fields a PATCH may change (signature may be partial). */
export interface AccountSettingsPatch {
  loadPictures?: boolean;
  signature?: { html?: string; logo?: string | null };
  templates?: AccountTemplate[];
  theme?: AccountSettings['theme'];
  defaultReply?: AccountSettings['defaultReply'];
  /** First-device import: only fills fields still at their defaults on the server. */
  importLocal?: { signature?: { html?: string; logo?: string | null }; templates?: AccountTemplate[]; loadPictures?: boolean };
}

export function getAccountSettings(): Promise<AccountSettings> {
  return request<AccountSettings>('/settings');
}

/**
 * Applies a change on top of the latest server document. On a version conflict (409) it re-reads and
 * retries, up to `retries` times, so two devices editing different fields do not lose either change.
 */
export async function patchAccountSettings(patch: AccountSettingsPatch, retries = 2): Promise<AccountSettings> {
  let current = await getAccountSettings();
  for (let attempt = 0; ; attempt++) {
    try {
      return await request<AccountSettings>('/settings', {
        method: 'PATCH',
        body: JSON.stringify({ ...patch, version: current.version })
      });
    } catch (err) {
      if ((err as { status?: number } | null)?.status !== 409 || attempt >= retries) throw err;
      current = await getAccountSettings();
    }
  }
}
