import { cn } from '@/lib/utils'
import { seriesBarClass } from '@/lib/variantSeries'

export interface RolloutSegment {
  variationId: string
  weight: number
  /** Palette slot; keeps a variation's colour identical everywhere it appears on the page. */
  series: number
  label?: string
}

/**
 * The split at a glance, before reading any numbers. Shared by the targeting editor, the
 * monitor's active-rollouts table and the diff preview so one flag's rollout looks the same
 * wherever you meet it.
 */
export function RolloutBar({
  segments,
  className,
  title,
}: {
  segments: readonly RolloutSegment[]
  className?: string
  title?: string
}) {
  return (
    <div
      className={cn('flex h-2 w-full overflow-hidden rounded-full bg-muted', className)}
      title={title ?? segments.map((s) => `${s.weight}% ${s.label ?? ''}`.trim()).join(' / ')}
      aria-hidden
    >
      {segments.map((segment, i) => (
        <div
          key={`${segment.variationId}-${i}`}
          className={seriesBarClass(segment.series)}
          style={{ width: `${Math.max(0, Math.min(100, segment.weight))}%` }}
        />
      ))}
    </div>
  )
}

/** Solid dot in a variation's series colour, for legends and table cells. */
export function SeriesDot({ series, className }: { series: number; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-2.5 w-2.5 shrink-0 rounded-full', seriesBarClass(series), className)}
    />
  )
}
