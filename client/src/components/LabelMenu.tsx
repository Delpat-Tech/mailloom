import React, { useRef, useState } from 'react';
import { Check, Minus, Plus } from 'lucide-react';
import { usePopover } from '../hooks/usePopover.js';
import { AnchoredPanel } from './AnchoredPanel.js';
import { LABEL_COLOURS, LABEL_NAME, LABEL_DOT, type Label, type LabelColour } from '../services/labels.js';
import { TagSwatch } from './LabelChip.js';

interface Props {
  labels: Label[];
  states: Record<string, 'on' | 'off' | 'mixed'>;
  onToggle: (labelId: string, turnOn: boolean) => void;
  /** Resolves with a message to show under the box when the label could not be created. */
  onCreate: (name: string, colour: LabelColour) => Promise<string | null | void> | void;
  onClose: (refocus: boolean) => void;
  className?: string;
  anchor?: React.RefObject<HTMLElement>;
}

/** Label menu: a checkbox per label, and "New label". */
export const LabelMenu: React.FC<Props> = ({
  labels,
  states,
  onToggle,
  onCreate,
  onClose,
  anchor
}) => {
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, onClose, anchor);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [colour, setColour] = useState<LabelColour>('blue');
  const [error, setError] = useState<string | null>(null);
  const trimmed = name.trim();

  return (
    <AnchoredPanel
      panelRef={ref}
      anchor={anchor}
      role="dialog"
      aria-label="Label"
      className="anim-menu origin-tr w-64 max-w-[calc(100vw-1rem)] bg-surface text-ink border border-line rounded shadow-xl py-1.5"
    >
      <div className="px-3 pt-1 pb-1.5 text-xs font-bold text-ink-3">Label</div>
      {labels.length === 0 && !creating && <p className="px-3 pb-2 text-[13px] text-ink-3">No labels yet.</p>}
      <div className="max-h-56 overflow-y-auto">
        {labels.map((l) => {
          const st = states[l.id] ?? 'off';
          return (
            <button
              key={l.id}
              type="button"
              role="menuitemcheckbox"
              aria-checked={st === 'on' ? true : st === 'mixed' ? 'mixed' : false}
              onClick={() => onToggle(l.id, st !== 'on')}
              className="t-fast w-full min-h-[44px] sm:min-h-[36px] px-3 flex items-center gap-2.5 text-sm font-semibold text-ink-2 hover:bg-sel hover:text-sel-ink"
            >
              <span
                aria-hidden="true"
                className={`w-4 h-4 shrink-0 rounded-[3px] border grid place-items-center ${
                  st === 'off' ? 'border-line-2' : 'border-act bg-act text-act-ink'
                }`}
              >
                {st === 'on' && <Check className="w-3 h-3" strokeWidth={3} />}
                {st === 'mixed' && <Minus className="w-3 h-3" strokeWidth={3} />}
              </span>
              <TagSwatch colour={l.colour} />
              <span className="truncate">{l.name}</span>
            </button>
          );
        })}
      </div>
      {creating ? (
        <form
          className="px-3 pt-2 pb-1 space-y-2 border-t border-line mt-1"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!trimmed) return;
            const err = await onCreate(trimmed, colour);
            if (err) setError(err);
          }}
        >
          <label htmlFor="new-label-name" className="block text-xs font-bold text-ink-2">
            New label
          </label>
          <input
            id="new-label-name"
            value={name}
            maxLength={40}
            onChange={(e) => {
              setName(e.target.value);
              setError(null);
            }}
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? 'new-label-error' : undefined}
            className="w-full bg-surface border border-line-2 rounded px-2 min-h-[44px] sm:min-h-[34px] text-base sm:text-sm text-ink"
          />
          {error && (
            <p id="new-label-error" role="alert" className="text-xs font-semibold text-warn-ink">
              {error}
            </p>
          )}
          <div role="group" aria-label="Colour" className="flex gap-1.5">
            {LABEL_COLOURS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={LABEL_NAME[c]}
                aria-pressed={colour === c}
                onClick={() => setColour(c)}
                className={`w-7 h-7 min-h-[44px] sm:min-h-0 sm:w-7 rounded grid place-items-center border ${
                  colour === c ? 'border-ink' : 'border-line'
                }`}
              >
                <span className={`w-3.5 h-3.5 rounded-[3px] ${LABEL_DOT[c]}`} />
              </button>
            ))}
          </div>
          <button
            type="submit"
            disabled={!trimmed}
            className="cut-tr w-full bg-act hover:bg-act-hov text-act-ink font-extrabold text-sm min-h-[40px] disabled:opacity-50"
          >
            Create and apply
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setCreating(true)}
          className="t-fast w-full min-h-[44px] sm:min-h-[36px] px-3 flex items-center gap-2 text-sm font-bold text-act hover:bg-hover border-t border-line mt-1"
        >
          <Plus className="w-4 h-4" aria-hidden="true" /> New label
        </button>
      )}
    </AnchoredPanel>
  );
};
