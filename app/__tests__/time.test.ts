import { dateTimeLabel, dayKey, dayLabel, relativeTime, shortDate } from '@shared/lib/time';

const NOW = new Date('2026-08-22T15:00:00Z').getTime();
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

describe('relativeTime', () => {
  it('collapses anything under a minute to "just now"', () => {
    expect(relativeTime(ago(0), NOW)).toBe('just now');
    expect(relativeTime(ago(59_000), NOW)).toBe('just now');
  });

  it('steps through minutes, hours, days, and weeks', () => {
    expect(relativeTime(ago(4 * MINUTE), NOW)).toBe('4m ago');
    expect(relativeTime(ago(3 * HOUR), NOW)).toBe('3h ago');
    expect(relativeTime(ago(2 * DAY), NOW)).toBe('2d ago');
    expect(relativeTime(ago(21 * DAY), NOW)).toBe('3w ago');
  });

  it('floors rather than rounds, so "1h ago" never shows before an hour has passed', () => {
    expect(relativeTime(ago(59 * MINUTE), NOW)).toBe('59m ago');
    expect(relativeTime(ago(23 * HOUR), NOW)).toBe('23h ago');
  });

  it('falls back to an absolute date past a year', () => {
    expect(relativeTime(ago(400 * DAY), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}, \d{4}$/);
  });

  it('treats clock skew (future stamps) as "just now" instead of a negative age', () => {
    expect(relativeTime(new Date(NOW + 5 * MINUTE).toISOString(), NOW)).toBe('just now');
  });

  it('returns an empty string for missing or unparseable input', () => {
    expect(relativeTime(undefined, NOW)).toBe('');
    expect(relativeTime('not-a-date', NOW)).toBe('');
  });
});

describe('day grouping', () => {
  it('keys by local calendar day', () => {
    const key = dayKey(ago(0));
    expect(key).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(dayKey(ago(HOUR))).toBe(key);
  });

  it('labels today and yesterday by name and older days by date', () => {
    expect(dayLabel(ago(0), NOW)).toBe('Today');
    expect(dayLabel(ago(DAY), NOW)).toBe('Yesterday');
    expect(dayLabel(ago(5 * DAY), NOW)).toMatch(/^[A-Z][a-z]{2} \d{1,2}$/);
  });

  it('adds the year only outside the reference year', () => {
    expect(shortDate('2026-08-12T10:00:00Z', 2026)).toBe('Aug 12');
    expect(shortDate('2025-08-12T10:00:00Z', 2026)).toBe('Aug 12, 2025');
  });
});

describe('dateTimeLabel', () => {
  it('renders a 12-hour clock with a padded minute', () => {
    expect(dateTimeLabel('2026-08-12T13:05:00', NOW)).toBe('Aug 12, 1:05 PM');
    expect(dateTimeLabel('2026-08-12T00:07:00', NOW)).toBe('Aug 12, 12:07 AM');
  });
});
