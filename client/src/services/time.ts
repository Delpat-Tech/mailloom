/** 24-hour clock, "HH:MM", for "Synced at" and "Draft saved". */
export function clockTime(d: Date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** "Mon 9 Nov, 09:00" for snooze confirmations. */
export function snoozeText(d: Date): string {
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${days[d.getDay()]} ${d.getDate()} ${months[d.getMonth()]}, ${clockTime(d)}`;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const short = (s: string) => s.slice(0, 3);

/** Whole calendar days from `d` to `now` (0 is today). */
export function daysAgo(d: Date, now: Date = new Date()): number {
  const a = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  return Math.round((b - a) / 86400000);
}

const valid = (d: Date) => !isNaN(d.getTime());

/** List rows: "10:38" today, "Thu" within the week, "12 Nov" older (with the year when it is another year). British, 24-hour. */
export function rowTime(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (!valid(d)) return '';
  const n = daysAgo(d, now);
  if (n === 0) return clockTime(d);
  if (n > 0 && n < 7) return short(DAYS[d.getDay()]);
  const base = `${d.getDate()} ${short(MONTHS[d.getMonth()])}`;
  return d.getFullYear() === now.getFullYear() ? base : `${base} ${d.getFullYear()}`;
}

/** "Sun 15 Nov 2026, 00:26" for tooltips and detail. */
export function fullDate(iso: string): string {
  const d = new Date(iso);
  if (!valid(d)) return '';
  return `${short(DAYS[d.getDay()])} ${d.getDate()} ${short(MONTHS[d.getMonth()])} ${d.getFullYear()}, ${clockTime(d)}`;
}

/** "On Sun 15 Nov 2026 at 00:26, Priya Shah wrote:" */
export function quoteLine(iso: string, who: string): string {
  const d = new Date(iso);
  const when = valid(d)
    ? `${short(DAYS[d.getDay()])} ${d.getDate()} ${short(MONTHS[d.getMonth()])} ${d.getFullYear()} at ${clockTime(d)}`
    : iso;
  return `On ${when}, ${who} wrote:`;
}

/** "6 min ago", "2 h ago", "3 days ago"; empty after a week (the date says it then). */
export function relativeAgo(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (!valid(d)) return '';
  const mins = Math.floor((now.getTime() - d.getTime()) / 60000);
  if (mins < 0) return '';
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} h ago`;
  const days = Math.floor(hrs / 24);
  return days < 7 ? `${days} day${days === 1 ? '' : 's'} ago` : '';
}

/** "Until Mon 09:00" for snoozed mail (within a week), otherwise "Until 21 Nov, 09:00". */
export function untilText(iso: string, now: Date = new Date()): string {
  const d = new Date(iso);
  if (!valid(d)) return '';
  const n = -daysAgo(d, now);
  if (n === 0) return `Until ${clockTime(d)}`;
  if (n > 0 && n < 7) return `Until ${short(DAYS[d.getDay()])} ${clockTime(d)}`;
  return `Until ${d.getDate()} ${short(MONTHS[d.getMonth()])}, ${clockTime(d)}`;
}

export type DayBucket = 'today' | 'yesterday' | 'week' | 'earlier';

export function dayBucket(iso: string, now: Date = new Date()): DayBucket {
  const d = new Date(iso);
  if (!valid(d)) return 'earlier';
  const n = daysAgo(d, now);
  if (n <= 0) return 'today';
  if (n === 1) return 'yesterday';
  return n < 7 ? 'week' : 'earlier';
}

const longDay = (d: Date) => `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;

/** Header text for a run of rows: "Today" with "Friday 14 November", "This week" with "10 to 12 November", and so on. */
export function groupHeader(bucket: DayBucket, dates: Date[]): { title: string; sub: string } {
  const ok = dates.filter(valid).sort((a, b) => a.getTime() - b.getTime());
  const first = ok[0];
  const last = ok[ok.length - 1];
  switch (bucket) {
    case 'today':
      return { title: 'Today', sub: last ? longDay(last) : '' };
    case 'yesterday':
      return { title: 'Yesterday', sub: last ? longDay(last) : '' };
    case 'week':
      if (!first || !last) return { title: 'This week', sub: '' };
      return {
        title: 'This week',
        sub:
          first.toDateString() === last.toDateString()
            ? `${first.getDate()} ${MONTHS[first.getMonth()]}`
            : first.getMonth() === last.getMonth()
              ? `${first.getDate()} to ${last.getDate()} ${MONTHS[last.getMonth()]}`
              : `${first.getDate()} ${short(MONTHS[first.getMonth()])} to ${last.getDate()} ${short(MONTHS[last.getMonth()])}`
      };
    default:
      return { title: 'Earlier', sub: '' };
  }
}

/** "INBOX" becomes "Inbox"; names that already have lower case are left as they are. */
export function folderTitle(name: string): string {
  if (name && name === name.toUpperCase() && /[A-Z]/.test(name)) return name.charAt(0) + name.slice(1).toLowerCase();
  return name;
}
