import React, { useState } from 'react';
import { getLoadPictures, setLoadPictures } from '../services/settings.js';

/** "Load pictures automatically": remote pictures in mail go through Mailloom's picture proxy. */
export const PicturesSetting: React.FC<{ handle: string; onChange?: (on: boolean) => void }> = ({ handle, onChange }) => {
  const [on, setOn] = useState(() => getLoadPictures(handle));
  return (
    <div className="border-t border-line pt-2 pb-1.5 px-1">
      <label className="flex items-start gap-2.5 min-h-[44px] lg:min-h-0 px-1.5 py-1 cursor-pointer">
        <input
          type="checkbox"
          checked={on}
          onChange={(e) => {
            setOn(e.target.checked);
            setLoadPictures(handle, e.target.checked);
            onChange?.(e.target.checked);
          }}
          className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--act)]"
        />
        <span className="text-xs">
          <span className="block font-bold text-ink-2">Load pictures automatically</span>
          <span className="block text-ink-3">Spam is always shown without pictures.</span>
        </span>
      </label>
    </div>
  );
};
