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
    // Not retryable: the spoofable subject and recipient are not shown.
    expect(screen.queryByText(/Quote/)).toBeNull();
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

describe('list as in the design', () => {
  it('groups rows under day headers and shows no Select bar until something is selected', () => {
    const now = new Date();
    const old = new Date(now.getFullYear() - 1, 0, 5).toISOString();
    list({}, [msg(1, { date: now.toISOString() }), msg(2, { date: old })]);
    expect(screen.getByText('Today')).toBeTruthy();
    expect(screen.getByText('Earlier')).toBeTruthy();
    expect(screen.queryByRole('toolbar', { name: 'Actions for selected messages' })).toBeNull();
    expect(screen.queryByText('Select')).toBeNull();
  });

  it('the avatar selects (Shift passes through) and the bulk bar appears with a selection', () => {
    const onToggleSelectUid = vi.fn();
    const { rerender } = list({ onToggleSelectUid });
    fireEvent.click(screen.getByRole('button', { name: 'Select message from Sender 2' }), { shiftKey: true });
    expect(onToggleSelectUid).toHaveBeenCalledWith(2, expect.objectContaining({ shiftKey: true }));
    rerender(
      <MessageList
        folderName="Inbox"
        messages={[msg(1), msg(2)]}
        totalMessages={2}
        selectedUid={null}
        onSelectMessage={() => {}}
        selectedUids={new Set([2])}
        onToggleSelectUid={onToggleSelectUid}
        onSelectAll={() => {}}
        onToggleFlag={() => {}}
        onRefresh={() => {}}
        isLoading={false}
        searchTerm=""
        onSearchChange={() => {}}
        onBatchDelete={() => {}}
        onBatchMarkRead={() => {}}
      />
    );
    expect(screen.getByRole('toolbar', { name: 'Actions for selected messages' })).toBeTruthy();
    expect(screen.getByText('1 selected')).toBeTruthy();
  });

  it('has no pager; "Load more" appears when there are more messages', () => {
    const onLoadMore = vi.fn();
    list({ hasMore: true, onLoadMore });
    expect(screen.queryByText(/Page \d+ of/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(onLoadMore).toHaveBeenCalled();
  });

  it('the header reads "Inbox  12 unread"', () => {
    list({ unreadCount: 12 });
    expect(screen.getByText('12 unread')).toBeTruthy();
  });
});

describe('empty views say what would appear there', () => {
  it('a search with no results names the search and offers Clear search', () => {
    const onSearchChange = vi.fn();
    list({ searchTerm: 'logo', onSearchChange }, []);
    expect(screen.getByText('No mail matches "logo"')).toBeTruthy();
    const clears = screen.getAllByRole('button', { name: 'Clear search' });
    expect(clears.length).toBe(2);
    fireEvent.click(clears[clears.length - 1]);
    expect(onSearchChange).toHaveBeenCalledWith('');
    expect(screen.queryByText(/currently empty/)).toBeNull();
  });

  it('every kind of empty view has its own words', async () => {
    const { emptyState } = await import('../components/MessageList.js');
    const base = { folderName: 'Inbox' };
    expect(emptyState({ ...base, viewKind: 'starred' }).title).toBe('Nothing starred yet');
    expect(emptyState({ ...base, viewKind: 'snoozed' }).hint).toMatch(/comes back/);
    expect(emptyState({ folderName: 'Client', viewKind: 'label' }).title).toBe('No mail labelled "Client"');
    expect(emptyState({ ...base, filter: 'unread' }).title).toBe('No unread mail');
    expect(emptyState({ ...base, filter: 'attachments' }).title).toBe('No mail with files here');
    expect(emptyState({ ...base, filter: 'starred' }).title).toBe('No starred mail here');
    expect(emptyState({ ...base, folderKind: 'Inbox' }).title).toBe('Your inbox is empty');
    expect(emptyState({ ...base, folderKind: 'Junk' }).title).toBe('No spam');
    expect(emptyState({ ...base, hasFilters: true }).action).toBe('clear-filters');
  });
});

describe('one click opens a row', () => {
  it('a click on the row button opens it once', () => {
    const onSelectMessage = vi.fn();
    list({ onSelectMessage });
    fireEvent.click(screen.getAllByRole('button', { name: /Subject 2/ })[0]);
    expect(onSelectMessage).toHaveBeenCalledTimes(1);
    expect(onSelectMessage).toHaveBeenCalledWith(2);
  });

  it('a click on the row padding opens it too, but the avatar and star do not', () => {
    const onSelectMessage = vi.fn();
    const onToggleFlag = vi.fn();
    const onToggleSelectUid = vi.fn();
    list({ onSelectMessage, onToggleFlag, onToggleSelectUid });
    const open = screen.getAllByRole('button', { name: /Subject 1/ })[0];
    fireEvent.click(open.parentElement!); // the row container, not a button
    expect(onSelectMessage).toHaveBeenCalledWith(1);
    onSelectMessage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Select message from Sender 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Star message from Sender 1' }));
    expect(onSelectMessage).not.toHaveBeenCalled();
    expect(onToggleSelectUid).toHaveBeenCalled();
    expect(onToggleFlag).toHaveBeenCalled();
  });

  it('rows do not use content-visibility (it made clicks land on the wrapper)', () => {
    list();
    const css = require('node:fs').readFileSync('src/motion.css', 'utf8') as string;
    expect(css).not.toMatch(/content-visibility\s*:/);
  });

  it('row hover is pure CSS: no mouse enter or over handlers on rows', () => {
    list();
    const btn = screen.getAllByRole('button', { name: /Subject 1/ })[0];
    const before = btn.outerHTML;
    fireEvent.mouseEnter(btn);
    fireEvent.mouseOver(btn);
    fireEvent.mouseLeave(btn);
    expect(btn.outerHTML).toBe(before);
  });
});

describe('row time slot', () => {
  it('snoozed rows show "Until ..." in the time slot, shared with the quick actions', () => {
    const when = new Date(Date.now() + 2 * 86400000);
    when.setHours(9, 0, 0, 0);
    list({}, [msg(1, { snoozedUntil: when.toISOString() })]);
    const slot = document.querySelector('.row-slot')!;
    expect(slot.querySelector('.row-time')!.textContent).toMatch(/^Until /);
    expect(slot.querySelector('.row-quick')).toBeTruthy(); // the actions live in the same slot as the time
  });
});
