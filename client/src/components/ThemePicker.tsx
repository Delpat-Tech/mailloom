import React, { useState } from 'react';
import { readThemeChoice, saveThemeChoice, type ThemeChoice } from '../services/theme.js';

const CHOICES: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' }
];

/** Light / Dark / System. The choice is remembered in this browser; System follows the device. */
export const ThemePicker: React.FC = () => {
  const [choice, setChoice] = useState<ThemeChoice>(() => readThemeChoice());
  return (
    <div role="group" aria-label="Colour theme" className="border-t border-line pt-2 pb-1.5 px-1">
      <div className="px-1.5 pb-1 text-xs font-bold text-ink-3">Theme</div>
      <div className="flex gap-0.5 p-0.5 rounded bg-sheet border border-line">
        {CHOICES.map((c) => (
          <button
            key={c.value}
            type="button"
            aria-pressed={choice === c.value}
            onClick={() => {
              setChoice(c.value);
              saveThemeChoice(c.value);
            }}
            className={`flex-1 min-h-[44px] lg:min-h-[28px] rounded-[3px] text-xs font-semibold transition-colors ${
              choice === c.value ? 'bg-act text-act-ink' : 'text-ink-2 hover:bg-hover'
            }`}
          >
            {c.label}
          </button>
        ))}
      </div>
    </div>
  );
};
