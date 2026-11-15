import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar.js';
import type { MailboxFolder } from '../types.js';

afterEach(cleanup);

const folder = (name: string, extra: Partial<MailboxFolder> = {}): MailboxFolder => ({
  path: name,
  name,
  delimiter: '/',
  flags: [],
  unreadCount: 0,
  totalCount: 0,
  ...extra
});
const folders = [
  folder('INBOX', { specialUse: 'Inbox' }),
  folder('Sent', { specialUse: 'Sent' }),
  folder('Deep'),
  folder('OtherFolder'),
  folder('Projects')
];
const labels = ['Client', 'Finance', 'Product', 'People', 'Ops'].map((n, i) => ({ id: String(i), name: n, colour: 'blue' as const, count: 0 }));

function renderRail() {
  return render(
    <Sidebar
      account={{ handle: 'h', email: 'a@delpat.test', name: 'A' }}
      folders={folders}
      labels={labels}
      selectedFolder="INBOX"
      onSelectFolder={() => {}}
      onOpenComposer={() => {}}
      onManageLabels={() => {}}
      syncedAt={new Date()}
    />
  );
}

// jsdom has no layout, so these check the structure that makes the rail behave at 700, 860 and 1080 px high:
// Write and the footer never shrink, and only the folders and labels area scrolls between them.
describe('rail layout', () => {
  it('scrolls folders and labels on their own between a fixed Write button and a fixed footer', () => {
    renderRail();
    const nav = screen.getByRole('navigation', { name: 'Folders' });
    expect(nav.className).toMatch(/flex-1/);
    expect(nav.className).toMatch(/min-h-0/);
    expect(nav.className).toMatch(/overflow-y-auto/);
    expect(nav.className).toMatch(/rail-scroll/);
    expect(screen.getByRole('button', { name: /^Write/ }).parentElement!.className).toMatch(/shrink-0/);
    expect(screen.getByRole('status').closest('.shrink-0')).not.toBeNull();
    // Every label is in the scrolling area, so it can be reached however short the window is.
    for (const n of ['People', 'Ops']) expect(nav.textContent).toContain(n);
    expect(nav.parentElement!.className).toMatch(/overflow-hidden/);
  });

  it('has only Write, folders, labels with Manage, and the synced line: no settings, install, notifications or account block', () => {
    const manage = vi.fn();
    render(
      <Sidebar
        account={{ handle: 'h', email: 'a@delpat.test', name: 'A' }}
        folders={folders}
        labels={labels}
        selectedFolder="INBOX"
        onSelectFolder={() => {}}
        onOpenComposer={() => {}}
        onManageLabels={manage}
        syncedAt={new Date(2026, 0, 1, 9, 5)}
      />
    );
    for (const gone of [
      /Install desktop app/,
      /Notifications/,
      /Allow notifications/,
      /Connected accounts/,
      /Add Another Mailbox/,
      /Disconnect Active Account/,
      /Connections/,
      /Accounts./,
      /Theme/,
      /Light/,
      /pictures/i
    ]) {
      expect(screen.queryByText(gone)).toBeNull();
      expect(screen.queryByRole('button', { name: gone })).toBeNull();
    }
    expect(screen.getByRole('status').textContent).toMatch(/^Synced at /);
    fireEvent.click(screen.getByRole('button', { name: 'Manage labels' }));
    expect(manage).toHaveBeenCalledTimes(1);
    // Only these buttons: close (phone), Write, folders, labels, Manage.
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') || b.textContent || '');
    expect(names.some((n) => /sign out|settings|install/i.test(n))).toBe(false);
  });
});
