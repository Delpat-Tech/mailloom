import { realUid } from './uidKey.js';
import { request } from './api.js';

export interface SnoozePreset {
  key: 'later' | 'tomorrow' | 'weekend' | 'nextweek';
  label: string;
  at: Date;
}

function atHour(base: Date, dayOffset: number, hour: number): Date {
  const d = new Date(base);
  d.setDate(d.getDate() + dayOffset);
  d.setHours(hour, 0, 0, 0);
  return d;
}

/**
 * The quick choices. "Later today" is 18:00 and is left out once it is 18:00 or later.
 * "This weekend" is the coming Saturday 09:00 (a week ahead when today is Saturday after 09:00).
 * "Next week" is the coming Monday 09:00.
 */
export function snoozePresets(now: Date = new Date()): SnoozePreset[] {
  const out: SnoozePreset[] = [];
  const evening = atHour(now, 0, 18);
  if (evening.getTime() > now.getTime()) out.push({ key: 'later', label: 'Later today', at: evening });
  out.push({ key: 'tomorrow', label: 'Tomorrow', at: atHour(now, 1, 9) });
  const day = now.getDay(); // 0 Sun .. 6 Sat
  let toSat = (6 - day + 7) % 7;
  if (toSat === 0 && now.getHours() >= 9) toSat = 7;
  out.push({ key: 'weekend', label: 'This weekend', at: atHour(now, toSat, 9) });
  let toMon = (1 - day + 7) % 7;
  if (toMon === 0) toMon = 7;
  out.push({ key: 'nextweek', label: 'Next week', at: atHour(now, toMon, 9) });
  return out;
}

export const snoozeApi = {
  snooze: (mailbox: string, uids: number[], until: Date) =>
    request<{ success: boolean }>('/messages/snooze', {
      method: 'POST',
      body: JSON.stringify({ mailbox, uids: uids.map(realUid), until: until.toISOString() })
    }),
  unsnooze: (uids: number[]) =>
    request<{ success: boolean }>('/messages/snooze', { method: 'DELETE', body: JSON.stringify({ uids: uids.map(realUid) }) })
};

/** Value for an input of type datetime-local (local time, minutes). */
export function toLocalInputValue(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}
