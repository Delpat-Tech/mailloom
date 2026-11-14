import React, { useRef, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog.js';
import { LABEL_COLOURS, LABEL_NAME, LABEL_DOT, type Label, type LabelColour } from '../services/labels.js';
import type { ConfirmRequest } from './ConfirmDialog.js';

interface Props {
  labels: Label[];
  onRename: (id: string, name: string) => void;
  onRecolour: (id: string, colour: LabelColour) => void;
  onDelete: (id: string) => void;
  onCreate: (name: string, colour: LabelColour) => void;
  requestConfirm: (r: ConfirmRequest) => void;
  onClose: () => void;
}

/** Manage labels from the rail: rename, colour, delete (with a confirmation). */
export const LabelsManager: React.FC<Props> = ({ labels, onRename, onRecolour, onDelete, onCreate, requestConfirm, onClose }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, { open: true, onEscape: onClose });
  const [newName, setNewName] = useState('');

  return (
    <div className="fixed inset-0 z-50 bg-scrim anim-scrim flex items-center justify-center p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby="labels-title"
        className="anim-dialog w-full max-w-md max-h-[90vh] flex flex-col bg-surface border border-line rounded shadow-2xl overflow-hidden"
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-line">
          <h2 id="labels-title" className="text-base font-extrabold text-ink">
            Manage labels
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
        <ul className="flex-1 overflow-y-auto p-3 space-y-2 list-none m-0">
          {labels.length === 0 && <li className="text-[13px] text-ink-3 px-2">No labels yet.</li>}
          {labels.map((l) => (
            <li key={l.id} className="flex items-center gap-2">
              <input
                defaultValue={l.name}
                aria-label={`Name of label ${l.name}`}
                maxLength={40}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== l.name) onRename(l.id, v);
                  else e.target.value = l.name;
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                }}
                className="flex-1 min-w-0 bg-surface border border-line-2 rounded px-2 min-h-[44px] sm:min-h-[34px] text-base sm:text-sm text-ink"
              />
              <div role="group" aria-label={`Colour of ${l.name}`} className="flex gap-0.5">
                {LABEL_COLOURS.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`${LABEL_NAME[c]} for ${l.name}`}
                    aria-pressed={l.colour === c}
                    onClick={() => l.colour !== c && onRecolour(l.id, c)}
                    className={`min-h-[44px] min-w-[32px] sm:min-h-[34px] sm:min-w-[28px] rounded grid place-items-center border ${
                      l.colour === c ? 'border-ink' : 'border-transparent hover:border-line-2'
                    }`}
                  >
                    <span className={`w-3.5 h-3.5 rounded-[3px] ${LABEL_DOT[c]}`} />
                  </button>
                ))}
              </div>
              <button
                type="button"
                aria-label={`Delete label ${l.name}`}
                onClick={() =>
                  requestConfirm({
                    title: `Delete the label "${l.name}"?`,
                    message: 'It is taken off every message. The messages themselves stay where they are.',
                    confirmLabel: 'Delete label',
                    danger: true,
                    onConfirm: () => onDelete(l.id)
                  })
                }
                className="min-h-[44px] min-w-[44px] sm:min-h-[34px] sm:min-w-[34px] grid place-items-center rounded text-ink-3 hover:text-warn-ink hover:bg-warn-bg"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2 p-3 border-t border-line"
          onSubmit={(e) => {
            e.preventDefault();
            const v = newName.trim();
            if (v) {
              onCreate(v, 'blue');
              setNewName('');
            }
          }}
        >
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            aria-label="New label name"
            placeholder="New label"
            maxLength={40}
            className="flex-1 min-w-0 bg-surface border border-line-2 rounded px-2 min-h-[44px] sm:min-h-[34px] text-base sm:text-sm text-ink"
          />
          <button
            type="submit"
            disabled={!newName.trim()}
            className="cut-tr bg-act hover:bg-act-hov text-act-ink font-extrabold text-sm px-4 min-h-[44px] sm:min-h-[34px] disabled:opacity-50"
          >
            Add
          </button>
        </form>
      </div>
    </div>
  );
};
