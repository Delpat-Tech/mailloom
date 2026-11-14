import React, { useRef } from 'react';
import { X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog.js';
import { SHORTCUTS } from '../services/shortcuts.js';

const GROUPS = ['Compose and find', 'On a message', 'Move around'] as const;

/** "?" opens this list of keyboard shortcuts. */
export const ShortcutsSheet: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, { open: true, onEscape: onClose });
  return (
    <div className="fixed inset-0 z-[60] bg-scrim anim-scrim flex items-center justify-center p-4" onClick={onClose}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        onClick={(e) => e.stopPropagation()}
        className="anim-dialog w-full max-w-lg max-h-[90vh] flex flex-col bg-surface border border-line rounded shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id="shortcuts-title" className="text-base font-extrabold text-ink">
            Keyboard shortcuts
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="min-h-[44px] min-w-[44px] sm:min-h-0 sm:min-w-0 sm:p-1.5 flex items-center justify-center rounded text-ink-3 hover:text-ink hover:bg-hover"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4 grid gap-5 sm:grid-cols-2">
          {GROUPS.map((g) => (
            <section key={g} aria-label={g}>
              <h3 className="text-xs font-bold text-ink-3 mb-2">{g}</h3>
              <ul className="list-none m-0 p-0 space-y-1.5">
                {SHORTCUTS.filter((s) => s.group === g).map((s) => (
                  <li key={s.action} className="flex items-center justify-between gap-3 text-[13.5px] text-ink">
                    <span>{s.label}</span>
                    <span className="flex gap-1">
                      {s.keys.map((k) => (
                        <kbd
                          key={k}
                          className="text-[11px] font-semibold leading-none px-1.5 py-[4px] min-w-[20px] text-center rounded-[3px] border border-line-2 bg-surface text-ink-2"
                        >
                          {k === 'ArrowDown' ? 'Down' : k === 'ArrowUp' ? 'Up' : k === 'Escape' ? 'Esc' : k.length === 1 ? k.toUpperCase() : k}
                        </kbd>
                      ))}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
        <p className="px-5 pb-4 text-xs text-ink-3">Shortcuts do not work while you are typing in a box.</p>
      </div>
    </div>
  );
};
