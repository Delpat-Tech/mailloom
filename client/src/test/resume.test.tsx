import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';
import { useResumeRefresh, RESUME_DEBOUNCE_MS, RESUME_MIN_GAP_MS } from '../hooks/useResumeRefresh.js';
import { folderAria, folderCount, labelUnread } from '../components/Sidebar.js';

function setVisibility(v: 'visible' | 'hidden') {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => v });
  document.dispatchEvent(new Event('visibilitychange'));
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-11-15T10:00:00Z'));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  setVisibility('visible');
});

describe('refresh on reopen', () => {
  it('refreshes once when the page is shown again after a while', () => {
    const refresh = vi.fn();
    renderHook(() => useResumeRefresh(true, refresh));
    setVisibility('hidden');
    vi.advanceTimersByTime(RESUME_MIN_GAP_MS + 1000);
    setVisibility('visible');
    expect(refresh).not.toHaveBeenCalled(); // debounced
    act(() => void vi.advanceTimersByTime(RESUME_DEBOUNCE_MS + 1));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('a quick switch away and back does not load twice, and visible + online count once', () => {
    const refresh = vi.fn();
    renderHook(() => useResumeRefresh(true, refresh));
    vi.advanceTimersByTime(RESUME_MIN_GAP_MS + 1000);
    setVisibility('hidden');
    setVisibility('visible');
    window.dispatchEvent(new Event('online'));
    act(() => void vi.advanceTimersByTime(RESUME_DEBOUNCE_MS + 1));
    expect(refresh).toHaveBeenCalledTimes(1);
    setVisibility('hidden');
    vi.advanceTimersByTime(1000);
    setVisibility('visible');
    act(() => void vi.advanceTimersByTime(RESUME_DEBOUNCE_MS + 1));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('coming back online refreshes even right after the last refresh', () => {
    const refresh = vi.fn();
    renderHook(() => useResumeRefresh(true, refresh));
    window.dispatchEvent(new Event('online'));
    act(() => void vi.advanceTimersByTime(RESUME_DEBOUNCE_MS + 1));
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does nothing while signed out', () => {
    const refresh = vi.fn();
    renderHook(() => useResumeRefresh(false, refresh));
    window.dispatchEvent(new Event('online'));
    vi.advanceTimersByTime(1000);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('sidebar counts', () => {
  const f = (specialUse: string | undefined, unreadCount: number, totalCount: number) =>
    ({ name: specialUse ?? 'Work', specialUse, unreadCount, totalCount }) as never;
  it('unread everywhere, drafts show how many drafts, and the spoken text matches', () => {
    expect(folderCount(f('Inbox', 3, 90))).toBe(3);
    expect(folderAria(f('Inbox', 3, 90))).toBe('Inbox, 3 unread');
    expect(folderCount(f('Junk', 0, 12))).toBe(0);
    expect(folderAria(f('Junk', 0, 12))).toBe('Spam');
    expect(folderAria(f('Drafts', 0, 2))).toBe('Drafts, 2 drafts');
    expect(folderAria(f('Drafts', 0, 1))).toBe('Drafts, 1 draft');
    expect(labelUnread({ count: 5, unread: 2 })).toBe(2);
    expect(labelUnread({ count: 5 })).toBe(5);
  });
});
