import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Logo } from '../components/Logo.js';
import { BOWL_SWEEP, BrandCurtain, LOWER_SWEEP, LogoMotion } from '../components/LogoMotion.js';
import { BOWL, SLAB } from '../components/markPaths.js';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the mark', () => {
  it('Logo, LogoMotion and the icon file share one geometry', () => {
    const { container } = render(<Logo />);
    const paths = [...container.querySelectorAll('path')].map((p) => p.getAttribute('d'));
    expect(paths).toContain(SLAB);
    expect(paths).toContain(BOWL);
    const icon = readFileSync(resolve(__dirname, '../../public/icon.svg'), 'utf8');
    expect(icon).toContain(SLAB);
    expect(icon).toContain(BOWL);
    expect(icon).not.toMatch(/F2B01E/i);
  });

  it('LogoMotion sweeps far enough to show each whole piece, and is hidden from screen readers', () => {
    const { container } = render(<LogoMotion mode="loader" />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('mk-loader')).toBe(true);
    expect(BOWL_SWEEP).toBeGreaterThan(180);
    expect(BOWL_SWEEP).toBeLessThan(360);
    expect(LOWER_SWEEP).toBeGreaterThan(120);
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
    act(() => void vi.advanceTimersByTime(1500));
    expect(container.querySelector('svg.mk-loader')).not.toBeNull();
    expect(gone).not.toHaveBeenCalled();
    rerender(<BrandCurtain kind="boot" ready onGone={gone} />);
    // Leaving: clicks pass through at once, and it is gone after a short fade.
    expect(curtain.className).toContain('pointer-events-none');
    act(() => void vi.advanceTimersByTime(200));
    expect(gone).toHaveBeenCalledTimes(1);
  });

  it('intro and outro never take clicks and end on their own', () => {
    for (const [kind, limit] of [['intro', 1200], ['outro', 640]] as const) {
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
