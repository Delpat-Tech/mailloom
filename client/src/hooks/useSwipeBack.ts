import { useEffect } from 'react';
import type { RefObject } from 'react';
import { insideHorizontalScroll, shouldClose, startsAtEdge } from '../services/swipe.js';

/**
 * Phone: drag the reader to the right to go back to the list. The pane follows the finger with
 * transform only; past 35% of the width (or a fast flick) it closes, otherwise it snaps back.
 * Touches inside the mail iframe are watched too (they do not reach the page).
 */
export function useSwipeBack(pane: RefObject<HTMLElement>, enabled: boolean, onClose: () => void) {
  useEffect(() => {
    const el = pane.current;
    if (!el || !enabled) return;
    const phone = () => window.matchMedia?.('(max-width: 767.98px)').matches;
    let s: { x: number; y: number; t: number; mode: 'pending' | 'drag' } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const reset = () => {
      el.style.transition = '';
      el.style.transform = '';
    };
    const start = (e: TouchEvent) => {
      s = null;
      if (!phone() || e.touches.length !== 1) return;
      const t = e.touches[0];
      if (startsAtEdge(t.screenX) || insideHorizontalScroll(e.target)) return;
      clearTimeout(timer);
      reset();
      s = { x: t.screenX, y: t.screenY, t: e.timeStamp, mode: 'pending' };
    };
    const move = (e: TouchEvent) => {
      if (!s) return;
      const t = e.touches[0];
      const dx = t.screenX - s.x;
      const dy = t.screenY - s.y;
      if (s.mode === 'pending') {
        if (dx < -10 || Math.abs(dy) > 10) {
          s = null; // a scroll, or the wrong way
          return;
        }
        if (dx > 10 && dx > Math.abs(dy) * 1.5) {
          s.mode = 'drag';
          el.style.transition = 'none';
        } else return;
      }
      if (e.cancelable) e.preventDefault();
      el.style.transform = `translateX(${Math.max(0, dx)}px)`;
    };
    const end = (e: TouchEvent, cancelled = false) => {
      if (!s || s.mode !== 'drag') {
        s = null;
        return;
      }
      const dx = (e.changedTouches[0]?.screenX ?? s.x) - s.x;
      const close = !cancelled && shouldClose(dx, el.clientWidth, e.timeStamp - s.t);
      s = null;
      if (close) {
        el.style.transition = 'transform var(--dur-3-out) var(--ease-in)';
        el.style.transform = 'translateX(100%)';
        onClose();
        timer = setTimeout(reset, 220);
      } else {
        el.style.transition = 'transform var(--dur-2) var(--ease-out)';
        el.style.transform = 'translateX(0)';
        timer = setTimeout(reset, 180);
      }
    };
    const onEnd = (e: TouchEvent) => end(e);
    const onCancel = (e: TouchEvent) => end(e, true);

    const docs = new Set<Document | HTMLElement>();
    const attach = (target: Document | HTMLElement) => {
      if (docs.has(target)) return;
      docs.add(target);
      target.addEventListener('touchstart', start as EventListener, { passive: true });
      target.addEventListener('touchmove', move as EventListener, { passive: false });
      target.addEventListener('touchend', onEnd as EventListener);
      target.addEventListener('touchcancel', onCancel as EventListener);
    };
    const attachFrames = () => {
      el.querySelectorAll('iframe').forEach((f) => {
        try {
          if (f.contentDocument) attach(f.contentDocument);
        } catch {
          /* cross-origin: not reachable */
        }
      });
    };
    attach(el);
    attachFrames();
    const onLoad = () => attachFrames();
    el.addEventListener('load', onLoad, true);
    const mo = new MutationObserver(attachFrames);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      clearTimeout(timer);
      reset();
      mo.disconnect();
      el.removeEventListener('load', onLoad, true);
      docs.forEach((d) => {
        d.removeEventListener('touchstart', start as EventListener);
        d.removeEventListener('touchmove', move as EventListener);
        d.removeEventListener('touchend', onEnd as EventListener);
        d.removeEventListener('touchcancel', onCancel as EventListener);
      });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);
}
