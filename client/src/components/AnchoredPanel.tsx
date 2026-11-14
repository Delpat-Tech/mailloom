import React, { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useLeaving } from './Presence.js';

const MARGIN = 8;

interface Props extends React.HTMLAttributes<HTMLDivElement> {
  /** The button the panel belongs to. Without it (or when it is not on screen) the parent of the panel's place in the tree is used. */
  anchor?: React.RefObject<HTMLElement>;
  /** Line up the panel's right edge ('end') or left edge ('start') with the button. */
  align?: 'start' | 'end';
  /** Open below the button, or above it. The other side is used when there is no room. */
  prefer?: 'below' | 'above';
  panelRef: React.RefObject<HTMLDivElement>;
}

/**
 * A menu or popover drawn on the page itself (a portal with position: fixed), placed from the
 * button's rectangle and kept inside the window with an 8 px margin. It never changes how any
 * container scrolls, and it is not clipped by one.
 */
export const AnchoredPanel: React.FC<Props> = ({ anchor, align = 'end', prefer = 'below', panelRef, className = '', style, children, ...rest }) => {
  const marker = useRef<HTMLSpanElement>(null);
  const leaving = useLeaving();
  const [pos, setPos] = useState<{ left: number; top: number; maxHeight: number } | null>(null);

  useLayoutEffect(() => {
    const place = () => {
      const panel = panelRef.current;
      if (!panel) return;
      let el: HTMLElement | null | undefined = anchor?.current;
      let rect = el?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        el = marker.current?.parentElement;
        rect = el?.getBoundingClientRect();
      }
      if (!rect) return;
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const w = panel.offsetWidth;
      const h = panel.offsetHeight;
      let left = align === 'end' ? rect.right - w : rect.left;
      left = Math.max(MARGIN, Math.min(left, vw - w - MARGIN));
      const roomBelow = vh - MARGIN - (rect.bottom + 4);
      const roomAbove = rect.top - 4 - MARGIN;
      const below = prefer === 'below' ? h <= roomBelow || roomBelow >= roomAbove : !(h <= roomAbove || roomAbove >= roomBelow);
      const room = below ? roomBelow : roomAbove;
      const height = Math.min(h, Math.max(room, 120));
      const top = below ? rect.bottom + 4 : rect.top - 4 - height;
      setPos((p) =>
        p && p.left === left && p.top === top && p.maxHeight === height ? p : { left, top: Math.max(MARGIN, top), maxHeight: height }
      );
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    const ro = typeof ResizeObserver !== 'undefined' && panelRef.current ? new ResizeObserver(place) : null;
    if (ro && panelRef.current) ro.observe(panelRef.current);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
      ro?.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor, align, prefer]);

  return (
    <>
      <span ref={marker} hidden />
      {createPortal(
        <div
          {...rest}
          ref={panelRef}
          data-leaving={leaving ? 'true' : undefined}
          className={`fixed z-[65] overflow-y-auto ${className}`}
          style={{
            ...style,
            left: pos?.left ?? 0,
            top: pos?.top ?? 0,
            maxHeight: pos ? pos.maxHeight : undefined,
            visibility: pos ? undefined : 'hidden'
          }}
        >
          {children}
        </div>,
        document.body
      )}
    </>
  );
};
