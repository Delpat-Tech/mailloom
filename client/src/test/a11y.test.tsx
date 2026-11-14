import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from '../components/ConfirmDialog.js';
import { ComposerModal } from '../components/ComposerModal.js';
import { MessageList } from '../components/MessageList.js';
import { friendlyError } from '../services/errors.js';
import type { MessageHeader } from '../types.js';

afterEach(cleanup);

describe('ConfirmDialog', () => {
  const req = { title: 'Delete forever?', message: 'Cannot be undone.', confirmLabel: 'Delete', onConfirm: vi.fn() };

  function Harness({ onClose }: { onClose: () => void }) {
    const [open, setOpen] = React.useState(false);
    return (
      <div>
        <button onClick={() => setOpen(true)}>open it</button>
        <ConfirmDialog
          request={open ? req : null}
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        />
      </div>
    );
  }

  it('is a labelled modal dialog, takes focus, traps Tab, closes on Escape and gives focus back', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);
    const opener = screen.getByText('open it');
    opener.focus();
    await user.click(opener);

    const dialog = screen.getByRole('dialog', { name: 'Delete forever?' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(dialog.contains(document.activeElement)).toBe(true);

    for (let i = 0; i < 5; i++) {
      await user.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await user.tab({ shift: true });
    expect(dialog.contains(document.activeElement)).toBe(true);

    await user.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
  });
});

describe('ComposerModal', () => {
  function renderComposer() {
    const onClose = vi.fn();
    const requestConfirm = vi.fn();
    render(
      <ComposerModal
        isOpen
        onClose={onClose}
        onSentSuccess={() => {}}
        requestConfirm={requestConfirm}
        accountEmail="a@delpat.test"
      />
    );
    return { onClose, requestConfirm };
  }

  it('is a labelled dialog and focuses the To field on open', () => {
    renderComposer();
    const dialog = screen.getByRole('dialog', { name: 'New Message' });
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(document.activeElement).toBe(screen.getByLabelText('To:'));
  });

  it('Escape on an empty composer closes it without asking', async () => {
    const { onClose, requestConfirm } = renderComposer();
    await userEvent.setup().keyboard('{Escape}');
    expect(requestConfirm).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('Escape with content asks to confirm and does not close', async () => {
    const user = userEvent.setup();
    const { onClose, requestConfirm } = renderComposer();
    await user.type(screen.getByLabelText('Subject:'), 'Quote for Pooja');
    await user.keyboard('{Escape}');
    expect(requestConfirm).toHaveBeenCalledTimes(1);
    expect(requestConfirm.mock.calls[0][0].title).toMatch(/draft/i);
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('MessageList keyboard', () => {
  const mk = (uid: number, isSeen: boolean): MessageHeader =>
    ({
      uid,
      subject: `Subject ${uid}`,
      from: { name: `Sender ${uid}`, address: `s${uid}@x.test` },
      date: '2026-01-02T10:00:00Z',
      isSeen,
      isFlagged: false,
      hasAttachments: false,
      snippet: 'hello'
    }) as unknown as MessageHeader;

  function renderList(onSelectMessage = vi.fn(), onCompose = vi.fn()) {
    render(
      <MessageList
        folderName="Inbox"
        messages={[mk(1, false), mk(2, true), mk(3, true)]}
        totalMessages={3}
        selectedUid={null}
        onSelectMessage={onSelectMessage}
        selectedUids={new Set()}
        onToggleSelectUid={() => {}}
        onSelectAll={() => {}}
        onToggleFlag={() => {}}
        onRefresh={() => {}}
        isLoading={false}
        searchTerm=""
        onSearchChange={() => {}}
        onBatchDelete={() => {}}
        onBatchMarkRead={() => {}}
        page={1}
        limit={50}
        onPageChange={() => {}}
        onCompose={onCompose}
      />
    );
    return { onSelectMessage, onCompose };
  }

  it('rows are buttons that announce unread state', () => {
    renderList();
    expect(screen.getByRole('button', { name: /^Unread, From Sender 1, Subject 1/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: /^From Sender 2, Subject 2/ })).toBeTruthy();
  });

  it('arrow keys move between rows and Enter opens the focused one', async () => {
    const user = userEvent.setup();
    const { onSelectMessage } = renderList();
    screen.getByRole('button', { name: /Subject 1/ }).focus();
    await user.keyboard('{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Subject 2/ }));
    await user.keyboard('{ArrowDown}{ArrowDown}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Subject 3/ }));
    await user.keyboard('{ArrowUp}');
    expect(document.activeElement).toBe(screen.getByRole('button', { name: /Subject 2/ }));
    await user.keyboard('{Enter}');
    expect(onSelectMessage).toHaveBeenCalledWith(2);
  });

  it('only one row is in the Tab order', () => {
    renderList();
    const rows = screen.getAllByRole('button', { name: /Subject \d/ });
    expect(rows.filter((r) => r.tabIndex === 0)).toHaveLength(1);
  });

  it('has a New message button for phones', () => {
    const { onCompose } = renderList();
    fireEvent.click(screen.getByRole('button', { name: 'New message' }));
    expect(onCompose).toHaveBeenCalled();
  });
});

describe('friendlyError', () => {
  it('turns network failures into a plain sentence', () => {
    expect(friendlyError(new TypeError('Failed to fetch'))).toBe(
      "Couldn't reach the mail server. Check your connection and try again."
    );
  });
  it('keeps plain server sentences', () => {
    expect(friendlyError(new Error('Two messages are already being sent. Wait a moment and try again.'))).toMatch(
      /already being sent/
    );
  });
  it('hides technical text', () => {
    for (const raw of [
      'Failed to fetch messages: Command failed',
      'connect ECONNREFUSED 127.0.0.1:993',
      'Request failed with status 500',
      'Unexpected token < in JSON at position 0',
      'SMTP Connection Failed: 535 5.7.8'
    ]) {
      const out = friendlyError(new Error(raw), 'Please try again.');
      expect(out).not.toMatch(/ECONN|status|JSON|SMTP|Command|535/);
    }
  });
});
