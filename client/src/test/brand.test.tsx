import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logo } from '../components/Logo.js';
import { BrandCurtain, LogoMotion } from '../components/LogoMotion.js';
import { DBAND, D_SWEEP, PBOWL, P_SWEEP, SLAB } from '../components/markPaths.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the mark', () => {
  it('Logo, LogoMotion and the icon file share one geometry', () => {
    const { container } = render(<Logo />);
    const paths = [...container.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    expect(paths).toEqual([DBAND, SLAB, PBOWL]);
    const icon = readFileSync(resolve(__dirname, '../../public/icon.svg'), 'utf8');
    for (const d of [DBAND, SLAB, PBOWL]) expect(icon).toContain(d);
    expect(icon).not.toMatch(/F2B01E/i);
  });

  it('LogoMotion draws the D and the bowl of the P as sweeps, and is hidden from screen readers', () => {
    const { container, rerender } = render(<LogoMotion mode="intro" />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('mk-intro')).toBe(true);
    expect(container.querySelector('.mk-d')).not.toBeNull();
    expect(container.querySelector('.mk-p')).not.toBeNull();
    // Each sweep is long enough to show its whole piece, and short of a full turn.
    for (const v of [D_SWEEP, P_SWEEP]) {
      expect(v.sweep).toBeGreaterThan(180);
      expect(v.sweep).toBeLessThan(360);
    }
    // The travelling arcs exist only while loading.
    expect(container.querySelector('.mk-orbit')).toBeNull();
    rerender(<LogoMotion mode="loader" />);
    expect(container.querySelector('.mk-orbit')).not.toBeNull();
  });
});

describe('BrandCurtain', () => {
  it('boot: a fast start shows it for no time at all', () => {
    const gone = vi.fn();
    const { rerender } = render(<BrandCurtain kind="boot" ready={false} onGone={gone} />);
    expect(gone).not.toHaveBeenCalled();
    rerender(<BrandCurtain kind="boot" ready onGone={gone} />);
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('boot: a slow start plays the intro, then loops, and leaves as soon as the app is ready', () => {
    const gone = vi.fn();
    const { container, rerender } = render(<BrandCurtain kind="boot" ready={false} onGone={gone} />);
    const curtain = container.firstElementChild as HTMLElement;
    expect(curtain.getAttribute('role')).toBe('status');
    expect(curtain.className).not.toContain('pointer-events-none');
    expect(container.querySelector('svg.mk-intro')).not.toBeNull();
    act(() => void vi.advanceTimersByTime(1600));
    expect(container.querySelector('svg.mk-loader')).not.toBeNull();
    expect(gone).not.toHaveBeenCalled();
    rerender(<BrandCurtain kind="boot" ready onGone={gone} />);
    // Leaving: clicks pass through at once, and it is gone after a short fade.
    expect(curtain.className).toContain('pointer-events-none');
    act(() => void vi.advanceTimersByTime(200));
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('intro and outro never take clicks and end on their own', () => {
    for (const [kind, limit] of [['intro', 1300], ['outro', 660]] as const) {
      const gone = vi.fn();
      const { container, unmount } = render(<BrandCurtain kind={kind} onGone={gone} />);
      const curtain = container.firstElementChild as HTMLElement;
      expect(curtain.className).toContain('pointer-events-none');
      expect(curtain.getAttribute('aria-hidden')).toBe('true');
      act(() => void vi.advanceTimersByTime(limit - 190));
      act(() => void vi.advanceTimersByTime(190));
      expect(gone).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('intro: leaves early when the mailbox is ready', () => {
    const gone = vi.fn();
    const { rerender } = render(<BrandCurtain kind="intro" onGone={gone} />);
    act(() => void vi.advanceTimersByTime(300));
    rerender(<BrandCurtain kind="intro" ready onGone={gone} />);
    act(() => void vi.advanceTimersByTime(200));
    expect(gone).toHaveBeenCalledTimes(1);
  });
});
