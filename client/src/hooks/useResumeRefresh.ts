import { useEffect, useRef } from 'react';

export const RESUME_DEBOUNCE_MS = 250;
/** A second switch back within this time does not load again. */
export const RESUME_MIN_GAP_MS = 5000;

/**
 * Calls `refresh` when the page becomes visible again or the browser comes back online.
 * Events that arrive together (visible + online) count once, and a quick switch away and back within
 * RESUME_MIN_GAP_MS of the last refresh does nothing.
 */
export function useResumeRefresh(enabled: boolean, refresh: () => void): void {
  const ref = useRef(refresh);
  ref.current = refresh;
  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let last = Date.now();
    const fire = () => {
      timer = undefined;
      if (document.visibilityState === 'hidden') return;
      if (Date.now() - last < RESUME_MIN_GAP_MS) return;
      last = Date.now();
      ref.current();
    };
    const schedule = () => {
      if (timer !== undefined) return;
      timer = setTimeout(fire, RESUME_DEBOUNCE_MS);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') schedule();
    };
    // Coming online counts even right after a refresh that failed for lack of a connection.
    const onOnline = () => {
      last = 0;
      schedule();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', onOnline);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', onOnline);
    };
  }, [enabled]);
}
