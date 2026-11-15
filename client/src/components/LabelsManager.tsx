import React, { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Trash2, X } from 'lucide-react';
import { useDialog } from '../hooks/useDialog.js';
import { LABEL_COLOURS, LABEL_NAME, LABEL_DOT, type Label, type LabelColour } from '../services/labels.js';
import type { ConfirmRequest } from './ConfirmDialog.js';

interface Props {
  labels: Label[];
  onRename: (id: string, name: string) => Promise<string | null | void> | void;
  onRecolour: (id: string, colour: LabelColour) => void;
  onDelete: (id: string) => void;
  onCreate: (name: string, colour: LabelColour) => Promise<string | null | void> | void;
  /** Move a label to a new position (0 is first). */
  onMove?: (id: string, position: number) => void;
  requestConfirm: (r: ConfirmRequest) => void;
  onClose: () => void;
  /** Drawn inside the Settings page (no dialog, no header, no close button). */
  embedded?: boolean;
}

/** Manage labels from the rail: rename, colour, delete (with a confirmation). */
export const LabelsManager: React.FC<Props> = ({ labels, onRename, onRecolour, onDelete, onCreate, onMove, requestConfirm, onClose, embedded = false }) => {
  const ref = useRef<HTMLDivElement>(null);
  useDialog(ref, { open: !embedded, onEscape: onClose });
  const [newName, setNewName] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});

  const shell = (inner: React.ReactNode) =>
    embedded ? (
      <div className="rounded border border-line bg-surface">{inner}</div>
    ) : (
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
        {inner}
      </div>
    </div>
    );

  return shell(
      <>
        <ul className={embedded ? 'p-3 space-y-2 list-none m-0' : 'flex-1 overflow-y-auto p-3 space-y-2 list-none m-0'}>
          {labels.length === 0 && <li className="text-[13px] text-ink-3 px-2">No labels yet.</li>}
          {labels.map((l, idx) => (
            <li key={l.id} className="flex items-center gap-2 flex-wrap">
              {onMove && (
                <div className="flex flex-col">
                  <button
                    type="button"
                    aria-label={`Move ${l.name} up`}
                    disabled={idx === 0}
                    onClick={() => onMove(l.id, idx - 1)}
                    className="min-h-[22px] min-w-[28px] grid place-items-center rounded text-ink-3 hover:text-ink hover:bg-hover disabled:opacity-30"
                  >
                    <ArrowUp className="w-3 h-3" />
                  </button>
                  <button
                    type="button"
                    aria-label={`Move ${l.name} down`}
                    disabled={idx === labels.length - 1}
                    onClick={() => onMove(l.id, idx + 1)}
                    className="min-h-[22px] min-w-[28px] grid place-items-center rounded text-ink-3 hover:text-ink hover:bg-hover disabled:opacity-30"
                  >
                    <ArrowDown className="w-3 h-3" />
                  </button>
                </div>
              )}
              <input
                defaultValue={l.name}
                aria-label={`Name of label ${l.name}`}
                maxLength={40}
                onBlur={async (e) => {
                  const input = e.target;
                  const v = input.value.trim();
                  if (v && v !== l.name) {
                    const err = await onRename(l.id, v);
                    setErrors((p) => ({ ...p, [l.id]: err || '' }));
                    if (err) input.value = l.name;
                  } else input.value = l.name;
                }}
                aria-invalid={errors[l.id] ? true : undefined}
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
              {errors[l.id] && (
                <p role="alert" className="basis-full text-xs font-semibold text-warn-ink">
                  {errors[l.id]}
                </p>
              )}
            </li>
          ))}
        </ul>
        <form
          className="flex gap-2 p-3 border-t border-line"
          onSubmit={async (e) => {
            e.preventDefault();
            const v = newName.trim();
            if (!v) return;
            const err = await onCreate(v, 'blue');
            setErrors((p) => ({ ...p, new: err || '' }));
            if (!err) setNewName('');
          }}
        >
          <input
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              setErrors((p) => ({ ...p, new: '' }));
            }}
            aria-invalid={errors.new ? true : undefined}
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
        {errors.new && (
          <p role="alert" className="px-3 pb-3 -mt-1 text-xs font-semibold text-warn-ink">
            {errors.new}
          </p>
        )}
      </>
    );
};
