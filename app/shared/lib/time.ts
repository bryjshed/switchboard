/**
 * Time formatting helpers. Pure functions with an injectable `now` so tests
 * never depend on the wall clock. Unit-tested in __tests__/time.test.ts.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/**
 * Compact relative time ("just now", "4m ago", "3h ago", "2d ago", "5w ago").
 * Anything older than ~1 year falls back to a short absolute date.
 * Returns '' for an unparseable timestamp so callers can skip the slot.
 */
export function relativeTime(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '';
  const delta = now - then;
  if (delta < 0) return 'just now';
  if (delta < MINUTE) return 'just now';
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < WEEK) return `${Math.floor(delta / DAY)}d ago`;
  if (delta < 365 * DAY) return `${Math.floor(delta / WEEK)}w ago`;
  return shortDate(iso);
}

/** Local calendar-day identity ("2026-08-22"), used to group feeds by day. */
export function dayKey(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return `invalid-${iso}`;
  void now;
  const month = `${d.getMonth() + 1}`.padStart(2, '0');
  const day = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${month}-${day}`;
}

/** "Today" / "Yesterday" / "Aug 12" / "Aug 12, 2025" for day-group headers. */
export function dayLabel(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const today = dayKey(new Date(now).toISOString());
  const yesterday = dayKey(new Date(now - DAY).toISOString());
  const key = dayKey(iso);
  if (key === today) return 'Today';
  if (key === yesterday) return 'Yesterday';
  return shortDate(iso, new Date(now).getFullYear());
}

/** "Aug 12" within the reference year, "Aug 12, 2025" otherwise. */
export function shortDate(iso: string, referenceYear?: number): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const month = MONTHS[d.getMonth()];
  const base = `${month} ${d.getDate()}`;
  return d.getFullYear() === (referenceYear ?? new Date().getFullYear())
    ? base
    : `${base}, ${d.getFullYear()}`;
}

/** "Aug 12, 2:05 PM" — absolute timestamp for detail rows. */
export function dateTimeLabel(iso: string, now: number = Date.now()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const hours24 = d.getHours();
  const suffix = hours24 >= 12 ? 'PM' : 'AM';
  const hours = hours24 % 12 === 0 ? 12 : hours24 % 12;
  const minutes = `${d.getMinutes()}`.padStart(2, '0');
  return `${shortDate(iso, new Date(now).getFullYear())}, ${hours}:${minutes} ${suffix}`;
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;
