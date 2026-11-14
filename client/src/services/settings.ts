/*
 * Per-account choices kept in this browser (localStorage) for now.
 */

const PICTURES_KEY = 'mailloom_load_pictures_v1';

function readMap(): Record<string, boolean> {
  try {
    const raw = localStorage.getItem(PICTURES_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : {};
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, boolean>) : {};
  } catch {
    return {};
  }
}

/** "Load pictures automatically": on unless this account turned it off. Spam/Junk always stays blocked (server). */
export function getLoadPictures(handle: string | null | undefined): boolean {
  if (!handle) return true;
  return readMap()[handle] !== false;
}

export function setLoadPictures(handle: string, on: boolean): void {
  try {
    const map = readMap();
    map[handle] = on;
    localStorage.setItem(PICTURES_KEY, JSON.stringify(map));
  } catch {
    // Storage unavailable: the choice lasts until the page is closed only.
  }
}
