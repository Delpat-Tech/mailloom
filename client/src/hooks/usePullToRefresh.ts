import { useEffect, useRef, useState, type RefObject } from 'react';

/** Drag distance (px) past which letting go refreshes. */
export const PULL_THRESHOLD = 64;
/** The indicator never travels further than this. */
export const PULL_MAX = 96;
/** Finger movement (px) before a gesture is read as vertical or horizontal. */
export const PULL_SLOP = 8;

/** Rubber-band: the indicator moves less than the finger, and less again the further it goes. */
export function pullOffset(dy: number): number {
  if (dy <= 0) return 0;
  return PULL_MAX * (1 - Math.exp(-dy / (PULL_MAX * 1.6)));
}

/** True when the finger has dragged far enough (raw distance) to refresh on release. */
export function pullReaches(dy: number): boolean {
  return dy >= PULL_THRESHOLD * 1.6;
}

/** Whether a first movement is a downward vertical drag (not a sideways swipe or an upward scroll). */
export function isDownwardPull(dx: number, dy: number): boolean {
  return dy > PULL_SLOP && Math.abs(dy) > Math.abs(dx);
}

interface Options {
  enabled: boolean;
  /** True while the refresh runs; the indicator stays until it turns false. */
  refreshing: boolean;
  onRefresh: () => void;
}

/** Touch pull-to-refresh for a scroller that is at its very top. Touch events only, so mouse and keyboard are untouched. */
export function usePullToRefresh(ref: RefObject<HTMLElement>, { enabled, refreshing, onRefresh }: Options) {
  const [offset, setOffset] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [holding, setHolding] = useState(false);
  const cb = useRef({ onRefresh, refreshing });
  cb.current = { onRefresh, refreshing };
  const sawLoading = useRef(false);

  useEffect(() => {
    if (!holding) return;
    if (refreshing) sawLoading.current = true;
    else if (sawLoading.current) {
      setHolding(false);
      setOffset(0);
    }
  }, [refreshing, holding]);

  // If the refresh never reports as loading (nothing to fetch), let go after a moment.
  useEffect(() => {
    if (!holding) return;
    const t = setTimeout(() => {
      setHolding(false);
      setOffset(0);
    }, 8000);
    return () => clearTimeout(t);
  }, [holding]);

  useEffect(() => {
    const el = ref.current;
    if (!el || !enabled) return;
    let startX = 0;
    let startY = 0;
    let state: 'idle' | 'pending' | 'pulling' | 'ignored' = 'idle';
    let dyNow = 0;

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1 || el.scrollTop > 0 || cb.current.refreshing) {
        state = 'ignored';
        return;
      }
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dyNow = 0;
      state = 'pending';
    };
    const onMove = (e: TouchEvent) => {
      if (state === 'idle' || state === 'ignored') return;
      if (e.touches.length !== 1) return end(false);
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (state === 'pending') {
        if (Math.abs(dx) > PULL_SLOP && Math.abs(dx) >= Math.abs(dy)) {
          state = 'ignored'; // a sideways swipe (swipe back): leave it alone
          return;
        }
        if (dy < -PULL_SLOP || el.scrollTop > 0) {
          state = 'ignored'; // an ordinary scroll up
          return;
        }
        if (!isDownwardPull(dx, dy)) return;
        state = 'pulling';
        setDragging(true);
      }
      dyNow = dy;
      if (e.cancelable) e.preventDefault();
      setOffset(pullOffset(dy));
    };
    const end = (allowRefresh: boolean) => {
      const was = state;
      state = 'idle';
      if (was !== 'pulling') return;
      setDragging(false);
      if (allowRefresh && pullReaches(dyNow)) {
        sawLoading.current = false;
        setHolding(true);
        setOffset(PULL_THRESHOLD * 0.75);
        cb.current.onRefresh();
      } else setOffset(0);
    };
    const onEnd = () => end(true);
    const onCancel = () => end(false);

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onCancel);
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onCancel);
    };
  }, [ref, enabled]);

  return { offset, dragging, holding, progress: Math.min(1, offset / (PULL_THRESHOLD * 0.75)) };
}
