import React, { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getUpdater } from '../services/updater.js';

/**
 * "New version ready": shown when a newer build exists but the page may not reload by itself (something is being
 * edited, or a reload did not bring the new version). Update saves drafts first, then reloads.
 * Lives inside the toast stack, which already sits above the phone tab bar.
 */
export const UpdateBar: React.FC = () => {
  const updater = getUpdater();
  const [, bump] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => updater?.subscribe(() => bump((n) => n + 1)), [updater]);
  if (!updater || !updater.barVisible) return null;
  return (
    <div
      role="status"
      data-testid="update-bar"
      className="anim-toast pointer-events-auto w-full px-4 py-2 rounded shadow-xl text-[13.5px] font-bold flex items-center gap-3 bg-toast-bg text-toast-ink border border-line"
    >
      <RefreshCw className="w-5 h-5 shrink-0 text-ok-ink" aria-hidden="true" />
      <span className="flex-1">New version ready</span>
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void updater.apply();
        }}
        className="t-fast min-h-[44px] px-2 font-extrabold text-toast-link hover:underline"
      >
        {busy ? 'Updating…' : 'Update'}
      </button>
    </div>
  );
};
