import { realUid } from './uidKey.js';
import { request } from './api.js';

/** The five label colours the server accepts, and the classes that draw them. */
export type LabelColour = 'mint' | 'coral' | 'lilac' | 'marigold' | 'blue';

export const LABEL_COLOURS: LabelColour[] = ['mint', 'coral', 'lilac', 'marigold', 'blue'];

// Full class names so Tailwind keeps them. Text/background pairs are the AA-checked ones from the palette.
export const LABEL_CHIP: Record<LabelColour, string> = {
  mint: 'text-l-client bg-l-client-bg',
  coral: 'text-l-people bg-l-people-bg',
  lilac: 'text-l-product bg-l-product-bg',
  marigold: 'text-l-finance bg-l-finance-bg',
  blue: 'text-l-ops bg-l-ops-bg'
};
export const LABEL_DOT: Record<LabelColour, string> = {
  mint: 'bg-lr-client',
  coral: 'bg-lr-people',
  lilac: 'bg-lr-product',
  marigold: 'bg-lr-finance',
  blue: 'bg-lr-ops'
};
export const LABEL_NAME: Record<LabelColour, string> = {
  mint: 'Mint',
  coral: 'Coral',
  lilac: 'Lilac',
  marigold: 'Marigold',
  blue: 'Blue'
};

export interface Label {
  id: string;
  name: string;
  colour: LabelColour;
  count: number;
}

/** Plain words for a failed label change. 409 is a name that is already used. */
export function labelErrorText(err: unknown, fallback: string): string {
  const status = (err as { status?: number } | null)?.status;
  if (status === 409) return 'A label with that name already exists';
  if (status === 400) return 'That label name or colour is not allowed. Try another.';
  return fallback;
}

export function colourOf(label: { colour?: string } | undefined): LabelColour {
  return label && (LABEL_COLOURS as string[]).includes(label.colour ?? '') ? (label.colour as LabelColour) : 'blue';
}

export const labelsApi = {
  list: async (): Promise<Label[]> => {
    const r = await request<Label[] | { labels: Label[] }>('/labels');
    return Array.isArray(r) ? r : (r.labels ?? []);
  },
  create: (name: string, colour: LabelColour) =>
    request<Label>('/labels', { method: 'POST', body: JSON.stringify({ name, colour }) }),
  update: (id: string, patch: { name?: string; colour?: LabelColour; order?: number }) =>
    request<Label>(`/labels/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) }),
  remove: (id: string) => request<{ success: boolean }>(`/labels/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** Add and remove labels on messages of one folder. */
  apply: (mailbox: string, uids: number[], add: string[], remove: string[]) =>
    request<{ success: boolean }>('/messages/labels', {
      method: 'POST',
      body: JSON.stringify({ mailbox, uids: uids.map(realUid), add, remove })
    })
};

/** What a label menu shows for the open message(s): checked, unchecked or (several messages) mixed. */
export function labelStates(labels: Label[], messages: { labels?: string[] }[]): Record<string, 'on' | 'off' | 'mixed'> {
  const out: Record<string, 'on' | 'off' | 'mixed'> = {};
  for (const l of labels) {
    const n = messages.filter((m) => m.labels?.includes(l.id)).length;
    out[l.id] = n === 0 ? 'off' : n === messages.length ? 'on' : 'mixed';
  }
  return out;
}
