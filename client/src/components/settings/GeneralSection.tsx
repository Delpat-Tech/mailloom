import React, { useState } from 'react';
import { ChevronRight, Keyboard } from 'lucide-react';
import type { AccountSettings } from '../../services/accountSettings.js';
import { readThemeChoice, saveThemeChoice, type ThemeChoice } from '../../services/theme.js';
import { Card, Segmented, Setting, Switch } from './ui.js';

interface Props {
  settings: AccountSettings;
  save: (patch: { loadPictures?: boolean; defaultReply?: AccountSettings['defaultReply'] }) => void;
  onOpenShortcuts: () => void;
}

/** True on a phone or tablet with no keyboard to speak of: the shortcuts row is hidden there. */
function touchOnly(): boolean {
  return !!window.matchMedia?.('(hover: none) and (pointer: coarse)')?.matches;
}

export const GeneralSection: React.FC<Props> = ({ settings, save, onOpenShortcuts }) => {
  const [theme, setTheme] = useState<ThemeChoice>(() => readThemeChoice());
  return (
    <div>
      <Card>
        <Setting title="Theme" help="Applies to this device only. System follows your phone or computer.">
          <Segmented<ThemeChoice>
            label="Theme"
            value={theme}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' }
            ]}
            onChange={(v) => {
              setTheme(v);
              saveThemeChoice(v);
            }}
          />
        </Setting>
        <Switch
          label="Load pictures automatically"
          description="Pictures load through Mailloom, so senders cannot see your location or device. Always off in Spam."
          checked={settings.loadPictures}
          onChange={(on) => save({ loadPictures: on })}
        />
        <Setting title="Default reply" help="What the main reply button does.">
          <Segmented<AccountSettings['defaultReply']>
            label="Default reply"
            value={settings.defaultReply}
            options={[
              { value: 'reply', label: 'Reply' },
              { value: 'replyAll', label: 'Reply all' }
            ]}
            onChange={(v) => save({ defaultReply: v })}
          />
        </Setting>
        {!touchOnly() && (
          <button
            type="button"
            onClick={onOpenShortcuts}
            className="t-fast flex items-center gap-3 py-3.5 min-h-[56px] text-left rounded hover:bg-hover -mx-2 px-2 w-[calc(100%+1rem)]"
          >
            <Keyboard className="w-5 h-5 text-ink-3 shrink-0" aria-hidden="true" />
            <span className="flex-1 min-w-0">
              <span className="block text-[14.5px] font-bold text-ink">Keyboard shortcuts</span>
              <span className="block text-[13px] text-ink-3">See every key that works in Mailloom.</span>
            </span>
            <ChevronRight className="w-4 h-4 text-ink-3 shrink-0" aria-hidden="true" />
          </button>
        )}
      </Card>
    </div>
  );
};
