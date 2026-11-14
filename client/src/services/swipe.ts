/** Rules for the phone swipe-back from the reader. Kept apart from the touch handling so they can be tested. */
export const EDGE_PX = 16; // the left edge belongs to the system back gesture
export const CLOSE_FRACTION = 0.35;
export const FLICK_PX_PER_MS = 0.6;
export const FLICK_MIN_PX = 40;

/** A swipe may not start at the very left edge. */
export function startsAtEdge(screenX: number): boolean {
  return screenX < EDGE_PX;
}

/** Past 35% of the width, or a fast flick to the right, closes; anything else snaps back. */
export function shouldClose(dx: number, width: number, elapsedMs: number): boolean {
  if (dx <= 0 || width <= 0) return false;
  if (dx > width * CLOSE_FRACTION) return true;
  return dx >= FLICK_MIN_PX && dx / Math.max(1, elapsedMs) > FLICK_PX_PER_MS;
}

/** Looks from where the finger landed up to the top: is any of it scrolled sideways? */
export function insideHorizontalScroll(target: EventTarget | null): boolean {
  let el = target instanceof Element ? target : null;
  while (el) {
    const view = el.ownerDocument?.defaultView;
    if (view && el.scrollWidth > el.clientWidth + 1) {
      const ox = view.getComputedStyle(el).overflowX;
      // The page itself (html/body) scrolls sideways when the mail is wider than the screen.
      if (ox === 'auto' || ox === 'scroll' || el === el.ownerDocument.documentElement || el === el.ownerDocument.body) return true;
    }
    el = el.parentElement;
  }
  return false;
}
