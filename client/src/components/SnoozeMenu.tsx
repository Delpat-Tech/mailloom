import React, { useMemo, useRef, useState } from 'react';
import { usePopover } from '../hooks/usePopover.js';
import { AnchoredPanel } from './AnchoredPanel.js';
import { snoozePresets, toLocalInputValue } from '../services/snooze.js';
import { clockTime, snoozeText } from '../services/time.js';

interface Props {
  onPick: (until: Date) => void;
  onClose: (refocus: boolean) => void;
  /** Where the menu sits, relative to its button. */
  className?: string;
  anchor?: React.RefObject<HTMLElement>;
}

/** "Snooze until": four quick times and a date and time of your own. */
export const SnoozeMenu: React.FC<Props> = ({ onPick, onClose, anchor }) => {
  const ref = useRef<HTMLDivElement>(null);
  usePopover(ref, onClose, anchor);
  const presets = useMemo(() => snoozePresets(new Date()), []);
  const [custom, setCustom] = useState(false);
  const [value, setValue] = useState(() => {
    const d = new Date(Date.now() + 3 * 3600 * 1000);
    d.setMinutes(0, 0, 0);
    return toLocalInputValue(d);
  });
  const when = new Date(value);
  const valid = !isNaN(when.getTime()) && when.getTime() > Date.now();

  return (
    <AnchoredPanel
      panelRef={ref}
      anchor={anchor}
      role="dialog"
      aria-label="Snooze until"
      className="anim-menu origin-tr w-64 max-w-[calc(100vw-1rem)] bg-surface text-ink border border-line rounded shadow-xl py-1.5"
    >
      <div className="px-3 pt-1 pb-1.5 text-xs font-bold text-ink-3">Snooze until</div>
      {presets.map((p) => (
        <button
          key={p.key}
          type="button"
          onClick={() => onPick(p.at)}
          className="t-fast w-full min-h-[44px] sm:min-h-[36px] px-3 flex items-center justify-between gap-3 text-sm font-semibold text-ink-2 hover:bg-sel hover:text-sel-ink"
        >
          <span>{p.label}</span>
          <span className="text-xs font-medium text-ink-3">
            {p.key === 'later' ? clockTime(p.at) : snoozeText(p.at)}
          </span>
        </button>
      ))}
      {custom ? (
        <div className="px-3 pt-2 pb-1 space-y-2 border-t border-line mt-1">
          <label htmlFor="snooze-custom" className="block text-xs font-bold text-ink-2">
            Date and time
          </label>
          <input
            id="snooze-custom"
            type="datetime-local"
            value={value}
            min={toLocalInputValue(new Date())}
            onChange={(e) => setValue(e.target.value)}
            className="w-full bg-surface border border-line-2 rounded px-2 min-h-[44px] sm:min-h-[34px] text-sm text-ink"
          />
          <button
            type="button"
            disabled={!valid}
            onClick={() => onPick(when)}
            className="cut-tr w-full bg-act hover:bg-act-hov text-act-ink font-extrabold text-sm min-h-[40px] disabled:opacity-50"
          >
            Snooze
          </button>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setCustom(true)}
          className="t-fast w-full min-h-[44px] sm:min-h-[36px] px-3 text-left text-sm font-semibold text-ink-2 hover:bg-sel hover:text-sel-ink border-t border-line mt-1"
        >
          Pick date and time
        </button>
      )}
    </AnchoredPanel>
  );
};
