import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { Logo } from '../components/Logo.js';
import { BrandCurtain, LogoMotion } from '../components/LogoMotion.js';
import { BOWL, BOWL_SWEEP, COUNTER, LOWER, LOWER_SWEEP, SLAB } from '../components/markPaths.js';

const pub = (name: string) => readFileSync(resolve(__dirname, '../../public', name), 'utf8');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('the mark', () => {
  it('Logo, the icon and the favicon share one geometry', () => {
    const { container } = render(<Logo />);
    const paths = [...container.querySelectorAll('svg > path')].map((p) => p.getAttribute('d'));
    expect(paths).toEqual([BOWL, SLAB, COUNTER, LOWER]);
    for (const file of ['icon.svg', 'mark.svg']) {
      const svg = pub(file);
      for (const d of [BOWL, SLAB, COUNTER, LOWER]) expect(svg).toContain(d);
      expect(svg).not.toMatch(/F2B01E/i);
    }
  });

  it('the Dusk colours in index.css match the ones make-icons.py put in the favicon', () => {
    const css = readFileSync(resolve(__dirname, '../index.css'), 'utf8');
    const favicon = pub('mark.svg');
    const piece: Record<string, string> = { s: 'slab', c: 'counter', l: 'lower', b: 'bowl' };
    const vars = [...css.matchAll(/--mk-([sclb])(\d):(#[0-9A-Fa-f]{6})/g)];
    expect(vars.length).toBe(27); // 9 stops, in the light block and both dark blocks
    for (const [, key, n, colour] of vars) expect(favicon).toContain(`.${piece[key]}${Number(n) - 1}{stop-color:${colour}}`);
  });

  it('two marks on one page do not share gradient ids', () => {
    const { container } = render(
      <>
        <Logo />
        <Logo />
        <LogoMotion mode="still" />
      </>
    );
    const ids = [...container.querySelectorAll('linearGradient')].map((g) => g.id);
    expect(ids.length).toBe(12);
    expect(new Set(ids).size).toBe(12);
    // Every fill points at a gradient inside its own svg.
    for (const svg of container.querySelectorAll('svg')) {
      for (const path of svg.querySelectorAll('path[fill^="url("]')) {
        const id = (path.getAttribute('fill') as string).slice(5, -1);
        expect(svg.querySelector(`[id="${id}"]`)).not.toBeNull();
      }
    }
  });

  it('the white tone uses no gradients and frosts the bowl', () => {
    const { container } = render(<Logo tone="white" />);
    expect(container.querySelector('linearGradient')).toBeNull();
    const [bowl, slab] = [...container.querySelectorAll('path')];
    expect(bowl.getAttribute('fill-opacity')).toBe('0.58');
    expect(slab.getAttribute('fill')).toBe('#FFFFFF');
  });

  it('LogoMotion masks only what the mode needs, and is hidden from screen readers', () => {
    const { container, rerender } = render(<LogoMotion mode="intro" />);
    const svg = container.querySelector('svg') as SVGElement;
    expect(svg.getAttribute('aria-hidden')).toBe('true');
    expect(svg.classList.contains('mk-intro')).toBe(true);
    // Intro: the bowl and the lower piece are swept in, far enough to show each whole piece.
    expect(container.querySelectorAll('mask').length).toBe(2);
    expect(container.querySelector('.mk-sweep-bowl')).not.toBeNull();
    expect(container.querySelector('.mk-sweep-lower')).not.toBeNull();
    for (const v of [BOWL_SWEEP, LOWER_SWEEP]) {
      expect(v.sweep).toBeGreaterThan(90);
      expect(v.sweep).toBeLessThan(360);
    }
    // Loader: every piece has its own mask, and no piece is moved.
    rerender(<LogoMotion mode="loader" />);
    expect(container.querySelectorAll('mask').length).toBe(4);
    expect(container.querySelector('.mk-win-slab')).not.toBeNull();
    expect(container.querySelector('.mk-win-counter')).not.toBeNull();
    for (const path of container.querySelectorAll('svg > path')) expect(path.getAttribute('mask')).toMatch(/^url\(#/);
    // Outro: the D is swept off, and the slab sinks behind a floor.
    rerender(<LogoMotion mode="outro" />);
    expect(container.querySelectorAll('mask').length).toBe(2);
    expect(container.querySelector('clipPath')).not.toBeNull();
    expect(container.querySelector('g[clip-path] > .mk-slab')).not.toBeNull();
    // Still: nothing but the four pieces.
    rerender(<LogoMotion mode="still" />);
    expect(container.querySelector('mask')).toBeNull();
    expect(container.querySelector('clipPath')).toBeNull();
  });

  it('the loader is one endless loop with no seam, and reduced motion shows the still mark', () => {
    const css = readFileSync(resolve(__dirname, '../motion.css'), 'utf8');
    const rules = [...css.matchAll(/\.mk-loader \.([\w-]+) \{ animation: mk-step-(\w+) (\d+)ms linear (-?\d+)ms infinite; \}/g)];
    expect(rules.map((r) => r[2])).toEqual(['slab', 'bowl', 'lower', 'counter']);
    const loop = Number(rules[0][3]);
    for (const r of rules) expect(Number(r[3])).toBe(loop); // one shared loop length, so the pieces never drift
    const delays = rules.map((r) => Number(r[4]));
    const step = delays[1] - delays[0];
    for (const d of delays) expect(d).toBeLessThanOrEqual(0); // starts part-way in: on the whole mark
    // Keyframes: hidden, shown from `inEnd` to `outStart`, hidden again from `outEnd`.
    const frames = css.match(/@keyframes mk-step-slab \{[\s\S]*?\n\}/)?.[0] ?? '';
    const [inEnd, outStart, outEnd] = [...frames.matchAll(/([\d.]+)%/g)]
      .map((m) => (Number(m[1]) / 100) * loop)
      .filter((v) => v > 0 && v < loop);
    // At the start every piece is fully shown.
    for (const d of delays) {
      expect(-d).toBeGreaterThanOrEqual(Math.round(inEnd));
      expect(-d).toBeLessThanOrEqual(Math.round(outStart));
    }
    // The seam: the last piece (three steps behind) is still leaving when the first one returns.
    expect(3 * step + outEnd).toBeGreaterThan(loop);
    expect(3 * step + outStart).toBeLessThan(loop);
    // Reduced motion: no animation, and without one no mask hides anything.
    expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.mk, \.mk \* \{ animation: none !important; \}/);
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
    for (const [kind, limit] of [['intro', 1300], ['outro', 880]] as const) {
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

describe('icon versioning', () => {
  // The same hash scripts/make-icons.py computes: name and bytes of every icon file, in name order.
  const files = ['apple-touch-icon.png', 'badge-96.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-192.png', 'icon-maskable-512.png', 'icon.svg', 'mark.svg'];
  const hash = createHash('sha256');
  for (const f of [...files].sort()) hash.update(Buffer.concat([Buffer.from(f), Buffer.from([0]), readFileSync(resolve(__dirname, '../../public', f)), Buffer.from([0])]));
  const v = hash.digest('hex').slice(0, 8);

  it('every icon URL in the manifest carries the hash of the icon files', () => {
    const m = JSON.parse(pub('manifest.webmanifest')) as { icons: { src: string }[]; shortcuts: { icons: { src: string }[] }[] };
    const srcs = [...m.icons, ...m.shortcuts.flatMap((s) => s.icons)].map((i) => i.src);
    expect(srcs.length).toBeGreaterThan(4);
    for (const src of srcs) expect(src).toMatch(new RegExp('^\\./[\\w.-]+\\?v=' + v + '$'));
  });

  it('the page, the notifications and the service worker use the same version', () => {
    const html = readFileSync(resolve(__dirname, '../../index.html'), 'utf8');
    expect(html).toContain(`href="./manifest.webmanifest?v=${v}"`);
    expect(html).toContain(`href="./mark.svg?v=${v}"`);
    expect(html).toContain(`href="./apple-touch-icon.png?v=${v}"`);
    const note = readFileSync(resolve(__dirname, '../services/notifications.ts'), 'utf8');
    expect(note).toContain(`./icon-192.png?v=${v}`);
    expect(note).toContain(`./badge-96.png?v=${v}`);
    const sw = pub('sw.js');
    expect(sw).toContain(`./icon-192.png?v=${v}`);
    expect(sw).toContain(`./badge-96.png?v=${v}`);
    expect(sw).not.toMatch(/\.(png|svg)(?!\?v=)['"]/);
  });

  it('the service worker never precaches the manifest or icons', () => {
    const sw = pub('sw.js');
    const precache = sw.slice(sw.indexOf('STATIC_ASSETS = ['), sw.indexOf('];'));
    expect(precache).not.toMatch(/manifest|icon|mark/);
    expect(sw).toContain('mailloom-shell-v6');
  });
});
