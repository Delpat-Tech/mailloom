import { useCallback, useEffect, useRef, useState } from 'react';
import { patchAccountSettings, type AccountSettings, type AccountSettingsPatch } from '../services/accountSettings.js';
import { applyServerThemeDefault, cacheSettings, loadSettings, readCachedSettings } from '../services/settingsSync.js';

export interface AccountSettingsState {
  settings: AccountSettings | null;
  /** A plain-language message when the settings could not be read. */
  loadError: string | null;
  /** Saves a change. Rejects with a readable Error when the server refuses it; the screen then shows the old value. */
  update: (patch: AccountSettingsPatch) => Promise<void>;
}

/** The signed-in mailbox's server settings (cached per browser for a quick start). */
export function useAccountSettings(handle: string | null, email: string | null): AccountSettingsState {
  const [state, setState] = useState<{ handle: string | null; settings: AccountSettings | null }>(() => ({
    handle,
    settings: handle ? readCachedSettings(handle) : null
  }));
  const [loadError, setLoadError] = useState<string | null>(null);
  const handleRef = useRef(handle);
  handleRef.current = handle;

  // Account switch: start from that account's cache.
  const settings = state.handle === handle ? state.settings : handle ? readCachedSettings(handle) : null;

  useEffect(() => {
    if (!handle || !email) return;
    let cancelled = false;
    setLoadError(null);
    loadSettings(email, handle)
      .then((s) => {
        if (cancelled) return;
        cacheSettings(handle, s);
        applyServerThemeDefault(s.theme);
        setState({ handle, settings: s });
      })
      .catch((err) => {
        if (!cancelled) setLoadError(err instanceof Error ? err.message : 'Settings could not be loaded.');
      });
    return () => {
      cancelled = true;
    };
  }, [handle, email]);

  const update = useCallback(async (patch: AccountSettingsPatch) => {
    const h = handleRef.current;
    if (!h) return;
    const saved = await patchAccountSettings(patch);
    cacheSettings(h, saved);
    if (handleRef.current === h) setState({ handle: h, settings: saved });
  }, []);

  return { settings, loadError, update };
}
