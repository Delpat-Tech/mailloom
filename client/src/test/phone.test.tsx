import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import {
  actionFor,
  commitDistance,
  startsInEdge,
  swipeIntent,
  swipeResult,
  swipeTravel
} from '../services/rowSwipe.js';
import { useOnline } from '../hooks/useOnline.js';
import { friendlyError } from '../services/errors.js';
import { ConnectModal } from '../components/ConnectModal.js';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('row swipe rules', () => {
  it('needs clear sideways intent before it starts', () => {
    expect(swipeIntent(4, 3)).toBe('undecided');
    expect(swipeIntent(30, 8)).toBe('horizontal');
    expect(swipeIntent(12, 30)).toBe('vertical');
    expect(swipeIntent(20, 18)).toBe('vertical'); // a diagonal is a scroll
  });
  it('ignores touches starting within 20 px of the left edge', () => {
    expect(startsInEdge(12)).toBe(true);
    expect(startsInEdge(20)).toBe(false);
  });
  it('left archives only where archiving is allowed; right marks read', () => {
    expect(actionFor(-50, true)).toBe('archive');
    expect(actionFor(-50, false)).toBeNull();
    expect(actionFor(50, false)).toBe('read');
  });
  it('commits only past the threshold', () => {
    const w = 375;
    const c = commitDistance(w);
    expect(swipeResult(-(c - 5), w, true)).toBeNull();
    expect(swipeResult(-c, w, true)).toBe('archive');
    expect(swipeResult(c + 10, w, true)).toBe('read');
    expect(swipeResult(-300, w, false)).toBeNull();
  });
  it('follows the finger then resists, and a refused side barely moves', () => {
    const w = 375;
    expect(swipeTravel(40, w, true)).toBe(40);
    expect(Math.abs(swipeTravel(-400, w, true))).toBeLessThanOrEqual(w * 0.6);
    expect(Math.abs(swipeTravel(-200, w, false))).toBeLessThanOrEqual(12);
  });
});

describe('offline', () => {
  function Probe() {
    return <p>{useOnline() ? 'online' : 'offline'}</p>;
  }
  it('follows the browser online and offline events', () => {
    render(<Probe />);
    expect(screen.getByText('online')).toBeTruthy();
    act(() => {
      vi.stubGlobal('navigator', { ...navigator, onLine: false });
      window.dispatchEvent(new Event('offline'));
    });
    expect(screen.getByText('offline')).toBeTruthy();
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    expect(screen.getByText('online')).toBeTruthy();
  });
  it('failed actions say you are offline in plain words', () => {
    vi.stubGlobal('navigator', { ...navigator, onLine: false });
    expect(friendlyError(new Error('Failed to fetch'))).toMatch(/offline/i);
  });
});

describe('sign-in fields', () => {
  it('suit a phone keyboard and the checkbox has a proper name', () => {
    render(<ConnectModal onConnected={vi.fn()} />);
    const email = screen.getByLabelText(/Email Address/);
    expect(email.getAttribute('inputmode')).toBe('email');
    expect(email.getAttribute('autocapitalize')).toBe('none');
    expect(email.getAttribute('autocorrect')).toBe('off');
    expect(email.getAttribute('spellcheck')).toBe('false');
    expect(email.getAttribute('enterkeyhint')).toBe('next');
    expect(screen.getByLabelText(/Password \*/).getAttribute('enterkeyhint')).toBe('go');
    expect(screen.getByRole('checkbox', { name: /Keep me signed in for 30 days/ })).toBeTruthy();
  });
});
