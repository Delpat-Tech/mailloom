import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, within, cleanup } from '@testing-library/react';
import { MessageList } from '../components/MessageList.js';
import { SnoozeMenu } from '../components/SnoozeMenu.js';
import { LabelMenu } from '../components/LabelMenu.js';
import { ShortcutsSheet } from '../components/ShortcutsSheet.js';
import { MobileTabBar } from '../components/MobileTabBar.js';
import type { MessageHeader } from '../types.js';

afterEach(cleanup);

function msg(uid: number, extra: Partial<MessageHeader> = {}): MessageHeader {
  return {
    uid,
    from: { name: `Sender ${uid}`, address: `s${uid}@x.test` },
    to: [{ name: '', address: 'me@x.test' }],
    subject: `Subject ${uid}`,
    date: new Date().toISOString(),
    flags: [],
    isSeen: false,
    isFlagged: false,
    hasAttachments: false,
    size: 1,
    snippet: 'hello',
    ...extra
  };
}

function list(props: Partial<React.ComponentProps<typeof MessageList>> = {}, messages: MessageHeader[] = [msg(1), msg(2)]) {
  return render(
    <MessageList
      folderName="Inbox"
      messages={messages}
      totalMessages={messages.length}
      selectedUid={null}
      onSelectMessage={() => {}}
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
      {...props}
    />
  );
}

describe('filter tabs', () => {
  it('shows All, Unread (with its count), Starred and With files, and reports the choice', () => {
    const onFilterChange = vi.fn();
    list({ filter: 'all', onFilterChange, unreadCount: 7 });
    expect(screen.getByRole('button', { name: 'All' }).getAttribute('aria-pressed')).toBe('true');
    const unread = within(screen.getByRole('group', { name: 'Show' })).getByRole('button', { name: /Unread/ });
    expect(unread.textContent).toContain('7');
    fireEvent.click(unread);
    expect(onFilterChange).toHaveBeenCalledWith('unread');
    fireEvent.click(screen.getByRole('button', { name: 'With files' }));
    expect(onFilterChange).toHaveBeenCalledWith('attachments');
    fireEvent.click(screen.getByRole('button', { name: 'Starred' }));
    expect(onFilterChange).toHaveBeenCalledWith('starred');
  });
});

describe('rows', () => {
  it('has hover quick actions: archive, read or unread, snooze', () => {
    const onArchive = vi.fn();
    const onToggleFlag = vi.fn();
    list({ onArchive, onToggleFlag, onSnooze: () => {} });
    fireEvent.click(screen.getByRole('button', { name: 'Archive message from Sender 1' }));
    expect(onArchive).toHaveBeenCalledWith(1, undefined);
    fireEvent.click(screen.getByRole('button', { name: 'Mark message from Sender 1 as read' }));
    expect(onToggleFlag).toHaveBeenCalledWith(1, 'isSeen', expect.anything());
    fireEvent.click(screen.getByRole('button', { name: 'Snooze message from Sender 1' }));
    expect(screen.getByRole('dialog', { name: 'Snooze until' })).toBeTruthy();
  });

  it('shows the thread count, label chips, and the not-delivered row', () => {
    list(
      { labels: [{ id: 'a', name: 'Client', colour: 'mint', count: 1 }] },
      [
        msg(1, { threadCount: 4, labels: ['a'] }),
        msg(2, { bounce: { originalSubject: 'Quote', recipient: 'x@y.test', reason: 'The mailbox is full.' } })
      ]
    );
    expect(screen.getByTitle('4 messages in this conversation')).toBeTruthy();
    expect(screen.getByText('Client')).toBeTruthy();
    expect(screen.getByText('Not delivered')).toBeTruthy();
    expect(screen.getByText('The mailbox is full.')).toBeTruthy();
  });

  it('marks drafts', () => {
    list({ folderKind: 'Drafts' }, [msg(1)]);
    expect(screen.getByText('Draft')).toBeTruthy();
  });
});

describe('menus and sheets', () => {
  it('snooze menu offers the quick times and a custom one', () => {
    const onPick = vi.fn();
    render(<SnoozeMenu onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: /^Tomorrow/ }));
    const when = onPick.mock.calls[0][0] as Date;
    expect(when.getHours()).toBe(9);
    fireEvent.click(screen.getByRole('button', { name: 'Pick date and time' }));
    expect(screen.getByLabelText('Date and time')).toBeTruthy();
  });

  it('label menu has checkboxes and New label', () => {
    const onToggle = vi.fn();
    const onCreate = vi.fn();
    render(
      <LabelMenu
        labels={[{ id: 'a', name: 'Client', colour: 'mint', count: 0 }]}
        states={{ a: 'off' }}
        onToggle={onToggle}
        onCreate={onCreate}
        onClose={() => {}}
      />
    );
    const box = screen.getByRole('menuitemcheckbox', { name: /Client/ });
    expect(box.getAttribute('aria-checked')).toBe('false');
    fireEvent.click(box);
    expect(onToggle).toHaveBeenCalledWith('a', true);
    fireEvent.click(screen.getByRole('button', { name: /New label/ }));
    fireEvent.change(screen.getByLabelText('New label'), { target: { value: 'Finance' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create and apply' }));
    expect(onCreate).toHaveBeenCalledWith('Finance', 'blue');
  });

  it('shortcuts sheet lists the keys and closes with Escape', () => {
    const onClose = vi.fn();
    render(<ShortcutsSheet onClose={onClose} />);
    expect(screen.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeTruthy();
    expect(screen.getByText('Archive')).toBeTruthy();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
  });

  it('phone tab bar has Write, Inbox, Starred, Search and Folders', () => {
    const onSelect = vi.fn();
    render(<MobileTabBar active="inbox" onSelect={onSelect} />);
    for (const n of ['Write', 'Inbox', 'Starred', 'Search', 'Folders']) {
      fireEvent.click(screen.getByRole('button', { name: n }));
    }
    expect(onSelect.mock.calls.map((c) => c[0])).toEqual(['write', 'inbox', 'starred', 'search', 'folders']);
    expect(screen.getByRole('button', { name: 'Inbox' }).getAttribute('aria-current')).toBe('page');
  });
});
