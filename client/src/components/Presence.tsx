import React, { createContext, useContext, useEffect, useRef, useState } from 'react';

/** True while the nearest Presence is playing its leaving animation (portalled panels read this). */
export const LeavingContext = createContext(false);
export const useLeaving = () => useContext(LeavingContext);

/** How long the leaving animations last (matches motion.css; the composer's is a little longer). */
export const LEAVE_MS = 130;
export const LEAVE_COMPOSER_MS = 180;

function reducedMotion(): boolean {
  try {
    return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Keeps something mounted while it plays its leaving animation.
 * `mounted` stays true for `ms` after `open` turns false; `leaving` is true during that time.
 * With reduced motion it unmounts at once.
 */
export function usePresence(open: boolean, ms = LEAVE_MS): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    if (reducedMotion()) {
      setMounted(false);
      return;
    }
    const t = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(t);
  }, [open, ms]);
  return { mounted: mounted || open, leaving: !open && mounted };
}

/**
 * `<Presence show={cond}>{cond && <Thing />}</Presence>`: when `show` turns false the last
 * children stay on screen, marked data-leaving, until the leaving animation has played.
 */
export const Presence: React.FC<{ show: boolean; ms?: number; children: React.ReactNode }> = ({ show, ms, children }) => {
  const { mounted, leaving } = usePresence(show, ms);
  const last = useRef<React.ReactNode>(null);
  if (show) last.current = children;
  if (!mounted) return null;
  return (
    <div style={{ display: 'contents' }} data-leaving={leaving ? 'true' : undefined}>
      <LeavingContext.Provider value={leaving}>{show ? children : last.current}</LeavingContext.Provider>
    </div>
  );
};
