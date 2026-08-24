import { useMemo } from 'react'
import { seriesColorVar } from '@/lib/variantSeries'
import type { SeriesIndex } from '@/lib/variantSeries'
import type { TimeSeries } from '@/lib/rolloutStats'

/**
 * Per-variant time series, drawn as inline SVG.
 *
 * Hand-written on purpose: a charting library would be ~100kB for one line chart, and it
 * would bring its own colour palette that does not know about `--series-*` or the light/dark
 * split. Every colour here resolves a CSS custom property at paint time, so the chart follows
 * the theme with no JavaScript involved.
 *
 * A bucket where a variant saw no traffic plots as a GAP, not a zero — a rollout that has not
 * reached a variation yet must not look like a variation with a 0% conversion rate.
 */

const VIEW_WIDTH = 720
const VIEW_HEIGHT = 180
const PAD_LEFT = 44
const PAD_RIGHT = 10
const PAD_TOP = 10
const PAD_BOTTOM = 22

export interface VariantSeriesChartProps {
  data: TimeSeries
  /** variationId → palette slot, so the chart matches the table and the rollout bar. */
  seriesMap: Map<string, SeriesIndex>
  /** Formats a y value for the axis labels and the accessible summary. */
  formatValue: (value: number) => string
  /** Names the metric in the accessible summary, e.g. "error rate". */
  metricLabel: string
  className?: string
}

interface PathSegment {
  d: string
}

function buildPaths(
  values: readonly (number | null)[],
  max: number,
  count: number,
): PathSegment[] {
  const plotWidth = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT
  const plotHeight = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM
  const x = (index: number) => PAD_LEFT + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth)
  const y = (value: number) => PAD_TOP + plotHeight - (Math.min(value, max) / (max || 1)) * plotHeight

  const segments: PathSegment[] = []
  let current: string[] = []
  values.forEach((value, index) => {
    if (value == null) {
      if (current.length > 0) {
        segments.push({ d: current.join(' ') })
        current = []
      }
      return
    }
    current.push(`${current.length === 0 ? 'M' : 'L'}${x(index).toFixed(2)},${y(value).toFixed(2)}`)
  })
  if (current.length > 0) segments.push({ d: current.join(' ') })
  // A lone point draws nothing as a path, so give it a zero-length line with a round cap.
  return segments.map((segment) =>
    segment.d.includes('L') ? segment : { d: `${segment.d} ${segment.d.replace('M', 'L')}` },
  )
}

function shortTime(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric' })
}

export function VariantSeriesChart({
  data,
  seriesMap,
  formatValue,
  metricLabel,
  className,
}: VariantSeriesChartProps) {
  const { labels, series, max } = data

  const gridValues = useMemo(() => [0, max / 2, max], [max])
  const plotHeight = VIEW_HEIGHT - PAD_TOP - PAD_BOTTOM
  const yFor = (value: number) => PAD_TOP + plotHeight - (value / (max || 1)) * plotHeight

  const summary = series
    .map((variant) => {
      const last = [...variant.points].reverse().find((p) => p.value != null)
      const name = variant.variationName ?? variant.variationId
      return `${name} ${last?.value != null ? formatValue(last.value) : 'no data'}`
    })
    .join('; ')

  const xTicks = labels.length === 0 ? [] : [0, Math.floor((labels.length - 1) / 2), labels.length - 1]
  const uniqueTicks = [...new Set(xTicks)]

  return (
    <svg
      viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
      className={className}
      role="img"
      data-testid="variant-series-chart"
      aria-label={`${metricLabel} per variation over ${labels.length} hourly buckets. Latest: ${summary || 'no data'}.`}
    >
      {gridValues.map((value) => (
        <g key={value}>
          <line
            x1={PAD_LEFT}
            x2={VIEW_WIDTH - PAD_RIGHT}
            y1={yFor(value)}
            y2={yFor(value)}
            stroke="hsl(var(--border))"
            strokeWidth={1}
            vectorEffect="non-scaling-stroke"
          />
          <text
            x={PAD_LEFT - 6}
            y={yFor(value) + 3}
            textAnchor="end"
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
          >
            {formatValue(value)}
          </text>
        </g>
      ))}

      {uniqueTicks.map((index) => {
        const plotWidth = VIEW_WIDTH - PAD_LEFT - PAD_RIGHT
        const x =
          PAD_LEFT + (labels.length <= 1 ? plotWidth / 2 : (index / (labels.length - 1)) * plotWidth)
        const anchor = index === 0 ? 'start' : index === labels.length - 1 ? 'end' : 'middle'
        return (
          <text
            key={index}
            x={x}
            y={VIEW_HEIGHT - 6}
            textAnchor={anchor}
            fontSize={10}
            fill="hsl(var(--muted-foreground))"
          >
            {shortTime(labels[index])}
          </text>
        )
      })}

      {series.map((variant) => {
        const slot = seriesMap.get(variant.variationId) ?? 0
        return buildPaths(
          variant.points.map((p) => p.value),
          max,
          labels.length,
        ).map((segment, i) => (
          <path
            key={`${variant.variationId}-${i}`}
            d={segment.d}
            fill="none"
            stroke={seriesColorVar(slot)}
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ))
      })}
    </svg>
  )
}
