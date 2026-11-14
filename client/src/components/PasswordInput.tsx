import React, { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

type Props = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> & {
  /** Change this value to hide the password again (for example after a sign-in attempt). */
  resetSignal?: unknown;
  wrapperClassName?: string;
};

/** A password field with a show/hide button inside it on the right. */
export const PasswordInput = forwardRef<HTMLInputElement, Props>(function PasswordInput(
  { resetSignal, wrapperClassName = '', className = '', ...rest },
  forwardedRef
) {
  const [shown, setShown] = useState(false);
  const innerRef = useRef<HTMLInputElement | null>(null);
  const restore = useRef<{ start: number | null; end: number | null } | null>(null);

  const setRefs = (el: HTMLInputElement | null) => {
    innerRef.current = el;
    if (typeof forwardedRef === 'function') forwardedRef(el);
    else if (forwardedRef) forwardedRef.current = el;
  };

  useEffect(() => {
    setShown(false);
  }, [resetSignal]);

  // After the type changes, put the caret back where it was (a type change can reset it).
  useLayoutEffect(() => {
    const el = innerRef.current;
    const saved = restore.current;
    if (el && saved) {
      restore.current = null;
      el.focus();
      try {
        el.setSelectionRange(saved.start ?? el.value.length, saved.end ?? el.value.length);
      } catch {
        /* some input types do not support selection */
      }
    }
  }, [shown]);

  return (
    <div className={`relative ${wrapperClassName}`}>
      <input {...rest} ref={setRefs} type={shown ? 'text' : 'password'} className={`${className} pr-12`} />
      <button
        type="button"
        aria-label={shown ? 'Hide password' : 'Show password'}
        aria-pressed={shown}
        // Keep focus where it is when tapped with a mouse or finger.
        onMouseDown={(e) => e.preventDefault()}
        onClick={(e) => {
          const el = innerRef.current;
          // detail is 0 for keyboard activation: leave focus on the button then.
          if (el && e.detail > 0) restore.current = { start: el.selectionStart, end: el.selectionEnd };
          setShown((s) => !s);
        }}
        className="absolute right-0 top-1/2 -translate-y-1/2 min-h-[44px] min-w-[44px] flex items-center justify-center text-ink-3 hover:text-ink rounded"
      >
        {shown ? <EyeOff className="w-4 h-4" aria-hidden="true" /> : <Eye className="w-4 h-4" aria-hidden="true" />}
      </button>
    </div>
  );
});
