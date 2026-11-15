import { useEffect, useState } from 'react';

/** True while the media query matches (and follows it as the window changes). */
export function useMediaQuery(query: string): boolean {
  const get = () => typeof window !== 'undefined' && !!window.matchMedia?.(query)?.matches;
  const [matches, setMatches] = useState(get);
  useEffect(() => {
    const mq = window.matchMedia?.(query);
    if (!mq) return;
    const on = () => setMatches(mq.matches);
    on();
    mq.addEventListener?.('change', on);
    return () => mq.removeEventListener?.('change', on);
  }, [query]);
  return matches;
}

/** The desktop layout (Tailwind lg). */
export const useDesktop = () => useMediaQuery('(min-width: 1024px)');
