import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/react';
import { MessageList } from '../components/MessageList.js';
import { PULL_THRESHOLD } from '../hooks/usePullToRefresh.js';
import type { MessageHeader } from '../types.js';

afterEach(cleanup);

const msg = (uid: number): MessageHeader => ({
  uid,
  mailbox: 'INBOX',
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
});

function props(over: Partial<React.ComponentProps<typeof MessageList>> = {}): React.ComponentProps<typeof MessageList> {
  return {
    folderName: 'Inbox',
    messages: [],
    totalMessages: 0,
    selectedUid: null,
    onSelectMessage: () => {},
    selectedUids: new Set(),
    onToggleSelectUid: () => {},
    onSelectAll: () => {},
    onToggleFlag: () => {},
    onRefresh: () => {},
    isLoading: false,
    searchTerm: '',
    onSearchChange: () => {},
    onBatchDelete: () => {},
    onBatchMarkRead: () => {},
    ...over
  };
}

const touch = (y: number) => ({ touches: [{ clientX: 100, clientY: y }] });

/** A finger pulling down from the top of the list, far enough to refresh. */
function pull(target: Element) {
  fireEvent.touchStart(target, touch(100));
  fireEvent.touchMove(target, touch(100 + 20));
  fireEvent.touchMove(target, touch(100 + PULL_THRESHOLD * 2));
  fireEvent.touchEnd(target, { touches: [] });
}

describe('pull to refresh', () => {
  it('works on a list that was still loading when the screen first rendered', () => {
    const onRefresh = vi.fn();
    const { rerender, getByRole } = render(<MessageList {...props({ onRefresh, isLoading: true })} />);
    rerender(<MessageList {...props({ onRefresh, messages: [msg(1), msg(2)], totalMessages: 2 })} />);
    pull(getByRole('list', { name: 'Inbox messages' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('works on an empty list', () => {
    const onRefresh = vi.fn();
    const { getByTestId, queryByRole } = render(<MessageList {...props({ onRefresh })} />);
    expect(queryByRole('list', { name: 'Inbox messages' })).toBeNull(); // the empty state, no scroller
    pull(getByTestId('pull-indicator').parentElement as Element);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('does not refresh when the list is scrolled down', () => {
    const onRefresh = vi.fn();
    const { getByRole } = render(<MessageList {...props({ onRefresh, messages: [msg(1)], totalMessages: 1 })} />);
    const ul = getByRole('list', { name: 'Inbox messages' });
    ul.scrollTop = 50;
    pull(ul);
    expect(onRefresh).not.toHaveBeenCalled();
  });
});
