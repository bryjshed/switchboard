import { cn } from '@/lib/utils'
import { seriesBarClass } from '@/lib/variantSeries'

/**
 * A rate rendered as a short bar so two variants can be compared without reading the digits.
 *
 * `max` is supplied by the caller and shared across a column, which is the whole point: bars
 * scaled independently would make 2% and 20% look identical. `tone` overrides the series
 * colour when a rate is bad enough that "which variation" matters less than "this is wrong".
 */
export function RateBar({
  value,
  max,
  series,
  tone = 'series',
  className,
}: {
  value: number
  max: number
  series: number
  tone?: 'series' | 'destructive' | 'muted'
  className?: string
}) {
  const ceiling = max > 0 ? max : 1
  const pct = Math.max(0, Math.min(100, (value / ceiling) * 100))
  const fill =
    tone === 'destructive'
      ? 'bg-destructive'
      : tone === 'muted'
        ? 'bg-muted-foreground/40'
        : seriesBarClass(series)
  return (
    <div className={cn('h-1.5 w-full overflow-hidden rounded-full bg-muted', className)} aria-hidden>
      <div className={cn('h-full rounded-full', fill)} style={{ width: `${pct}%` }} />
    </div>
  )
}
