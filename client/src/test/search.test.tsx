import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react';
import { MessageList } from '../components/MessageList.js';
import { openSearch, hasSearch, SEARCH_AFTER_READER_MS, SEARCH_EVENT } from '../services/searchAll.js';
import type { MessageHeader } from '../types.js';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function msg(uid: number, mailbox: string): MessageHeader {
  return {
    uid,
    mailbox,
    from: { name: `Sender ${uid}`, address: `s${uid}@x.test` },
    to: [{ name: '', address: 'me@x.test' }],
    subject: `Subject ${uid}`,
    date: new Date().toISOString(),
    flags: [],
    isSeen: true,
    isFlagged: false,
    hasAttachments: false,
    size: 1,
    snippet: 'hello'
  };
}

function list(props: Partial<React.ComponentProps<typeof MessageList>> = {}) {
  const messages = [msg(1, 'Archive'), msg(2, 'Sent')];
  return render(
    <MessageList
      folderName="Search results"
      messages={messages}
      totalMessages={2}
      selectedUid={null}
      onSelectMessage={() => {}}
      selectedUids={new Set()}
      onToggleSelectUid={() => {}}
      onSelectAll={() => {}}
      onToggleFlag={() => {}}
      onRefresh={() => {}}
      isLoading={false}
      searchTerm="invoice"
      onSearchChange={() => {}}
      onBatchDelete={() => {}}
      onBatchMarkRead={() => {}}
      {...props}
    />
  );
}

describe('search everywhere', () => {
  it('the box is a search field with a Search key on phones', () => {
    list();
    const box = screen.getByRole('searchbox', { name: 'Search messages' });
    expect(box.getAttribute('type')).toBe('search');
    expect(box.getAttribute('enterkeyhint')).toBe('search');
  });

  it('shows the folder of each result and offers All folders / This folder', () => {
    const onSearchScopeChange = vi.fn();
    list({ searchAll: true, folderNames: { Archive: 'Archive', Sent: 'Sent' }, searchScope: 'all', onSearchScopeChange });
    expect(screen.getByTitle('In Archive')).toBeTruthy();
    expect(screen.getByTitle('In Sent')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'All folders' }).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'This folder' }));
    expect(onSearchScopeChange).toHaveBeenCalledWith('folder');
  });

  it('inside a view the scope toggle gives way to a plain note', () => {
    list({ viewKind: 'starred', searchAll: true });
    expect(screen.queryByRole('button', { name: 'This folder' })).toBeNull();
    expect(screen.getByText('Searching all folders')).toBeTruthy();
  });

  it('from the reader: the reader closes first, then the search box opens', () => {
    vi.useFakeTimers();
    const order: string[] = [];
    window.addEventListener(SEARCH_EVENT, () => order.push('search'), { once: true });
    openSearch(() => order.push('close reader'), true);
    expect(order).toEqual(['close reader']);
    act(() => {
      vi.advanceTimersByTime(SEARCH_AFTER_READER_MS + 1);
    });
    expect(order).toEqual(['close reader', 'search']);
  });

  it('the list opens its search box on that event', () => {
    vi.useFakeTimers();
    list({ searchTerm: '' });
    act(() => {
      window.dispatchEvent(new Event(SEARCH_EVENT));
      vi.advanceTimersByTime(50);
    });
    expect(document.activeElement).toBe(screen.getByRole('searchbox'));
  });

  it('knows when a search is in use', () => {
    expect(hasSearch('  ')).toBe(false);
    expect(hasSearch('', { from: 'a@x.test' })).toBe(true);
    expect(hasSearch('x')).toBe(true);
  });
});
