/** Short absolute timestamp; the full ISO value goes in a `title` attribute at the call site. */
export function formatDateTime(iso: string | undefined | null): string {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/** "3 days ago" style, for the "last changed" column where recency is what matters. */
export function formatRelative(iso: string | undefined | null, now = Date.now()): string {
  if (!iso) return '—'
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return '—'
  const seconds = Math.round((then - now) / 1000)
  const abs = Math.abs(seconds)
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  if (abs < 60) return rtf.format(Math.round(seconds), 'second')
  if (abs < 3600) return rtf.format(Math.round(seconds / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(seconds / 3600), 'hour')
  if (abs < 2592000) return rtf.format(Math.round(seconds / 86400), 'day')
  if (abs < 31536000) return rtf.format(Math.round(seconds / 2592000), 'month')
  return rtf.format(Math.round(seconds / 31536000), 'year')
}

/** The most recent `updatedAt` across a flag's environment summaries, plus who did it. */
export function latestChange<T extends { updatedAt?: string; updatedBy?: string }>(
  items: readonly T[],
): { updatedAt?: string; updatedBy?: string } {
  let best: T | undefined
  for (const item of items) {
    if (!item.updatedAt) continue
    if (!best?.updatedAt || new Date(item.updatedAt) > new Date(best.updatedAt)) best = item
  }
  return { updatedAt: best?.updatedAt, updatedBy: best?.updatedBy }
}
