import { useEffect } from 'react';
import type { RefObject } from 'react';

/**
 * A menu that opens next to its button: focus moves to the first control, Up/Down move between
 * controls, Escape and a click outside close it (Tab leaves it and closes it).
 */
export function usePopover(ref: RefObject<HTMLElement>, onClose: (refocus: boolean) => void, anchor?: RefObject<HTMLElement>) {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = () =>
      Array.from(root.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])'));
    items()[0]?.focus({ preventScroll: true });
    const onDown = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!root.contains(t) && !anchor?.current?.contains(t)) onClose(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose(true);
      } else if (e.key === 'Tab') {
        onClose(false);
      } else if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && !(e.target as HTMLElement).matches('input[type="datetime-local"]')) {
        e.preventDefault();
        const list = items();
        const i = list.indexOf(document.activeElement as HTMLElement);
        const next = e.key === 'ArrowDown' ? (i + 1) % list.length : (i - 1 + list.length) % list.length;
        list[next]?.focus();
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
      document.removeEventListener('keydown', onKey, true);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
