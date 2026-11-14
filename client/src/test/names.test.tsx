import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar.js';
import { MessageList } from '../components/MessageList.js';
import { MessageViewer } from '../components/MessageViewer.js';
import { ComposerModal } from '../components/ComposerModal.js';
import { ConnectModal } from '../components/ConnectModal.js';
import type { MessageHeader, ParsedEmailMessage, MailboxFolder } from '../types.js';

afterEach(cleanup);

/** Simplified accessible name: aria-labelledby, aria-label, visible text (images/svg ignored), then title. */
function nameOf(el: Element): string {
  const by = el.getAttribute('aria-labelledby');
  if (by) {
    const t = by.split(/\s+/).map((id) => document.getElementById(id)?.textContent || '').join(' ').trim();
    if (t) return t;
  }
  const label = el.getAttribute('aria-label')?.trim();
  if (label) return label;
  const clone = el.cloneNode(true) as Element;
  clone.querySelectorAll('[aria-hidden="true"], svg').forEach((n) => n.remove());
  const text = (clone.textContent || '').trim();
  if (text) return text;
  return el.getAttribute('title')?.trim() || '';
}

function expectAllButtonsNamed(container: HTMLElement) {
  const unnamed = Array.from(container.querySelectorAll('button, [role="button"]'))
    .filter((b) => !nameOf(b))
    .map((b) => b.outerHTML.slice(0, 160));
  expect(unnamed).toEqual([]);
}

const folders: MailboxFolder[] = [
  { path: 'INBOX', name: 'Inbox', specialUse: 'Inbox', unreadCount: 2, totalCount: 5 } as unknown as MailboxFolder,
  { path: 'Trash', name: 'Trash', specialUse: 'Trash', unreadCount: 0, totalCount: 1 } as unknown as MailboxFolder
];
const header = {
  uid: 1,
  subject: 'S',
  from: { name: 'A', address: 'a@x.test' },
  date: '2026-01-02T10:00:00Z',
  isSeen: false,
  isFlagged: true,
  hasAttachments: true,
  snippet: 'hello'
} as unknown as MessageHeader;
const message = {
  uid: 1, id: '<1@x>', subject: 'Hello', from: { name: 'A', address: 'a@x.test' },
  to: [], cc: [], bcc: [], replyTo: [], references: [], date: '2026-01-01T10:00:00Z', flags: [],
  isSeen: true, isFlagged: false, html: '<p>hi</p>', text: 'hi',
  attachments: [{ partId: '2', filename: 'a.pdf', contentType: 'application/pdf', size: 10, isInline: false }],
  blockedImages: 2
} as unknown as ParsedEmailMessage;

describe('every button has an accessible name', () => {
  it('Sidebar, with install, notifications and the account switcher open', () => {
    const { container } = render(
      <Sidebar
        account={{ handle: 'h', email: 'a@delpat.test', name: 'A' }}
        folders={folders}
        selectedFolder="INBOX"
        onSelectFolder={() => {}}
        onOpenComposer={() => {}}
        onLogout={() => {}}
        savedAccounts={[{ handle: 'h', email: 'a@delpat.test', name: 'A', lastActive: 1 }, { handle: 'g', email: 'b@delpat.test', lastActive: 0 }]}
        onSwitchAccount={() => {}}
        onAddAccount={() => {}}
        onRemoveAccount={() => {}}
        canInstall
        onInstallApp={() => {}}
        notificationPermission="default"
        onRequestNotifications={() => {}}
        onCloseMobileSidebar={() => {}}
      />
    );
    expectAllButtonsNamed(container);
    fireEvent.click(screen.getByRole('button', { name: /^Accounts/ }));
    expectAllButtonsNamed(container);
  });

  it('MessageList with a selection', () => {
    const { container } = render(
      <MessageList
        folderName="Inbox" messages={[header]} totalMessages={1} selectedUid={null}
        onSelectMessage={() => {}} selectedUids={new Set([1])} onToggleSelectUid={() => {}}
        onSelectAll={() => {}} onToggleFlag={() => {}} onRefresh={() => {}} isLoading={false}
        searchTerm="" onSearchChange={() => {}} onBatchDelete={() => {}} onBatchMarkRead={() => {}}
        page={1} limit={50} onPageChange={() => {}} onCompose={() => {}}
      />
    );
    expectAllButtonsNamed(container);
  });

  it('MessageViewer in the inbox and in Trash', () => {
    for (const kind of [undefined, 'Trash'] as const) {
      const { container, unmount } = render(
        <MessageViewer
          folderPath="INBOX" message={message} isLoading={false} folderKind={kind}
          onToggleFlag={() => {}} onDelete={() => {}} onMove={() => {}} onMarkSpam={() => {}}
          onRestore={() => {}} onShowImages={() => {}} onReply={() => {}} onForward={() => {}}
          folders={folders} onBackToList={() => {}}
        />
      );
      expectAllButtonsNamed(container);
      unmount();
    }
  });

  it('Composer and the connect dialog', () => {
    const c = render(
      <ComposerModal isOpen onClose={() => {}} onSentSuccess={() => {}} requestConfirm={() => {}} accountEmail="a@delpat.test" />
    );
    expectAllButtonsNamed(c.container);
    expectAllButtonsNamed(document.body);
  });
});

describe('connect screen buttons', () => {
  it('all named, with install and notifications offered', () => {
    const { container } = render(
      <ConnectModal
        onConnected={() => {}}
        canInstall
        onInstallApp={() => {}}
        notificationPermission="default"
        onRequestNotifications={() => {}}
        onCancel={() => {}}
      />
    );
    expectAllButtonsNamed(container);
  });
});
