import React, { useEffect, useId, useRef, useState } from 'react';
import { avatarClass, initialsOf } from '../services/avatar.js';
import { formatSuggestion, isValidRecipient, nameOfEntry, addressOf, splitPasted } from '../services/recipients.js';
import { suggestContacts, type ContactSuggestion } from '../services/mailExtras.js';

export const SUGGEST_DEBOUNCE_MS = 120;

interface Props {
  id: string;
  label: string;
  list: string[];
  input: string;
  onInput: (value: string) => void;
  /** Add typed or chosen text (one or several entries). */
  onAdd: (value: string) => void;
  onRemove: (index: number) => void;
  nameOf: (entry: string) => string;
  inputRef?: React.RefObject<HTMLInputElement>;
  placeholder?: string;
  trailing?: React.ReactNode;
}

/** One recipient line (To, Cc or Bcc): chips, the typing box and the suggestions list. */
export const RecipientField: React.FC<Props> = ({ id, label, list, input, onInput, onAdd, onRemove, nameOf, inputRef, placeholder, trailing }) => {
  const listId = useId();
  const [options, setOptions] = useState<ContactSuggestion[]>([]);
  const [active, setActive] = useState(-1);
  const [open, setOpen] = useState(false);
  const seq = useRef(0);
  const listRef = useRef(list);
  listRef.current = list;

  useEffect(() => {
    const q = input.trim();
    if (q.length < 1) {
      seq.current++;
      setOptions([]);
      setOpen(false);
      return;
    }
    const mine = ++seq.current;
    const t = setTimeout(() => {
      suggestContacts(q)
        .then((res) => {
          if (mine !== seq.current) return;
          const have = new Set(listRef.current.map((e) => addressOf(e).toLowerCase()));
          const fresh = res.filter((r) => !have.has(r.email.toLowerCase()));
          setOptions(fresh);
          setActive(-1);
          setOpen(fresh.length > 0);
        })
        .catch(() => {
          if (mine === seq.current) setOpen(false);
        });
    }, SUGGEST_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [input]);

  const choose = (s: ContactSuggestion) => {
    seq.current++;
    setOpen(false);
    setOptions([]);
    onAdd(formatSuggestion(s.name, s.email));
  };

  const showing = open && options.length > 0;

  return (
    <div className="py-1.5 flex items-center gap-2">
      <label htmlFor={id} className="text-ink-3 font-medium w-12">{label}:</label>
      <div className="flex-1 flex flex-wrap items-center gap-1.5 relative">
        {list.map((entry, idx) => {
          const shown = nameOf(entry) || nameOfEntry(entry) || addressOf(entry);
          const bad = !isValidRecipient(entry);
          return (
            <span
              key={idx}
              aria-invalid={bad || undefined}
              title={bad ? 'Not a valid address' : addressOf(entry)}
              className={`inline-flex items-center gap-1.5 bg-sheet text-ink border border-line pl-[3px] pr-1.5 py-[2px] rounded-[3px] text-[13px] font-bold${bad ? ' !bg-warn-bg !text-warn-ink !border-warn-line line-through' : ''}`}
            >
              <span aria-hidden="true" className={`cut-av w-5 h-5 shrink-0 grid place-items-center text-[9px] font-extrabold text-white ${avatarClass(addressOf(entry))}`}>
                {initialsOf(shown)}
              </span>
              <span>
                {shown}
                {bad && <span className="sr-only"> (not a valid address)</span>}
              </span>
              <button type="button" onClick={() => onRemove(idx)} aria-label={`Remove ${shown}`} className="hover:text-act px-1 min-h-[44px] sm:min-h-0">
                ×
              </button>
            </span>
          );
        })}
        <input
          id={id}
          ref={inputRef}
          type="email"
          role="combobox"
          aria-expanded={showing}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showing && active >= 0 ? `${listId}-${active}` : undefined}
          autoComplete="off"
          autoCapitalize="none"
          value={input}
          onChange={(e) => onInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown' && options.length > 0) {
              e.preventDefault();
              setOpen(true);
              setActive((a) => (a + 1) % options.length);
            } else if (e.key === 'ArrowUp' && showing) {
              e.preventDefault();
              setActive((a) => (a <= 0 ? options.length - 1 : a - 1));
            } else if (e.key === 'Escape' && showing) {
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            } else if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              if (e.key === 'Enter' && showing && active >= 0) choose(options[active]!);
              else onAdd(input);
            } else if (e.key === 'Tab' && !e.shiftKey && showing && input.trim()) {
              // Tab takes the highlighted suggestion, or the first one when what was typed is not yet an address.
              const pick = active >= 0 ? options[active] : isValidRecipient(input.trim()) ? undefined : options[0];
              if (pick) {
                e.preventDefault();
                choose(pick);
              }
            } else if (e.key === 'Backspace' && input === '' && list.length > 0) {
              e.preventDefault();
              onRemove(list.length - 1);
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData?.getData('text') ?? '';
            const parts = splitPasted(text);
            if (parts.length > 1) {
              e.preventDefault();
              onAdd(parts.join(','));
            }
          }}
          onBlur={() => {
            setOpen(false);
            if (input) onAdd(input);
          }}
          placeholder={placeholder ?? (list.length === 0 ? 'Name or email' : '')}
          className="flex-1 min-w-[140px] focus:outline-none bg-transparent py-0.5 text-ink max-sm:text-[16px]"
        />
        {showing && (
          <ul
            id={listId}
            role="listbox"
            aria-label={`${label} suggestions`}
            className="absolute left-0 top-full mt-1 z-30 w-full max-w-md max-h-64 overflow-y-auto bg-surface text-ink border border-line rounded shadow-xl py-1"
          >
            {options.map((o, i) => (
              <li
                key={o.email}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(o)}
                onMouseEnter={() => setActive(i)}
                className={`px-3 py-2 min-h-[44px] sm:min-h-0 cursor-pointer flex flex-col justify-center text-[13px] ${i === active ? 'bg-sel text-sel-ink' : 'hover:bg-hover'}`}
              >
                {o.name && o.name.toLowerCase() !== o.email.toLowerCase() ? (
                  <>
                    <span className="font-bold truncate">{o.name}</span>
                    <span className="text-ink-3 text-xs truncate">{o.email}</span>
                  </>
                ) : (
                  <span className="font-bold truncate">{o.email}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {trailing}
    </div>
  );
};
