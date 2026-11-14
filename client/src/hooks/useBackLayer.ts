import { useEffect, useRef, useState } from 'react';
import { LayerStack, browserPort } from '../services/layers.js';

let stack: LayerStack | null = null;

function getStack(): LayerStack {
  if (!stack) {
    stack = new LayerStack(browserPort());
    // A reload keeps the old depth tag: start again from the base.
    const s = window.history.state as { mlLayer?: number } | null;
    if (s?.mlLayer) window.history.replaceState({ mlLayer: 0 }, '');
    window.addEventListener('popstate', (e) => {
      const d = (e.state as { mlLayer?: number } | null)?.mlLayer ?? 0;
      stack?.onPop(d);
    });
  }
  return stack;
}

/** Phones and tablets (below the desktop layout), where Back means "close this screen". */
function isCompact(): boolean {
  return !!window.matchMedia?.('(max-width: 1023.98px)')?.matches;
}

/**
 * While `open`, the layer has a history entry: the phone Back button (or gesture) calls `onClose`.
 * If `onClose` leaves the layer open (for example it asks "save this draft?"), the entry is put back.
 */
export function useBackLayer(open: boolean, onClose: () => void): void {
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const [epoch, setEpoch] = useState(0);
  useEffect(() => {
    if (!open || !isCompact()) return;
    const s = getStack();
    const entry = s.open(
      () => closeRef.current(),
      () => setEpoch((n) => n + 1)
    );
    return () => s.release(entry);
  }, [open, epoch]);
}
