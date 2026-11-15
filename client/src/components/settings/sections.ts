import { Bell, KeyRound, PenLine, Settings, Smartphone, Tag, Users } from 'lucide-react';

export type SectionId = 'general' | 'writing' | 'notifications' | 'labels' | 'accounts' | 'connections' | 'app';

export const SECTIONS: { id: SectionId; title: string; icon: typeof Settings; blurb: string }[] = [
  { id: 'general', title: 'General', icon: Settings, blurb: 'Theme, pictures and replies.' },
  { id: 'writing', title: 'Writing', icon: PenLine, blurb: 'Your signature and reusable messages.' },
  { id: 'notifications', title: 'Notifications', icon: Bell, blurb: 'Hear about new mail on this device, even when Mailloom is closed.' },
  { id: 'labels', title: 'Labels', icon: Tag, blurb: 'Add, rename, recolour, reorder and delete labels.' },
  { id: 'accounts', title: 'Accounts', icon: Users, blurb: 'The mailboxes you are signed in to on this device.' },
  { id: 'connections', title: 'Connections', icon: KeyRound, blurb: 'Let Work OS and Claude use this mailbox, with keys you control.' },
  { id: 'app', title: 'App', icon: Smartphone, blurb: 'Install Mailloom, check for updates and get help.' }
];

export const sectionTitle = (id: SectionId) => SECTIONS.find((s) => s.id === id)!.title;

const IDS = new Set<string>(SECTIONS.map((s) => s.id));

/** "#/settings" or "#/settings/<section>" gives the section (General when none is named); anything else is null. */
export function parseSettingsHash(hash: string): SectionId | null {
  const m = /^#\/settings(?:\/([a-z]+))?\/?$/.exec(hash);
  if (!m) return null;
  return m[1] && IDS.has(m[1]) ? (m[1] as SectionId) : 'general';
}

export const settingsHash = (id: SectionId) => `#/settings/${id}`;
