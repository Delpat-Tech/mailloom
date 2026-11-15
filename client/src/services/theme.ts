/** Light / Dark / System choice. The choice is kept in localStorage; System follows the device. */
export type ThemeChoice = 'light' | 'dark' | 'system';

const KEY = 'mailloom.theme';

export function readThemeChoice(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'light' || v === 'dark') return v;
  } catch {
    /* storage blocked: follow the system */
  }
  return 'system';
}

/** True once this device has a choice of its own (System counts); until then the server's theme is the default. */
export function hasStoredThemeChoice(): boolean {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' || v === 'system';
  } catch {
    return false;
  }
}

/** Put the choice on <html>: System removes the attribute so the media query decides. */
export function applyThemeChoice(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
}

export function saveThemeChoice(choice: ThemeChoice): void {
  try {
    localStorage.setItem(KEY, choice);
  } catch {
    /* not remembered; still applied for this visit */
  }
  applyThemeChoice(choice);
}
