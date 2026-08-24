import type { RolloutStatsBucket, VariantStats } from '@/types/api'

/**
 * Derivations over `/rollout-stats`. Everything here is pure so the judgements the UI makes
 * about a rollout — who is winning, who is erroring, how tall the chart is — are testable
 * without rendering anything.
 *
 * Rates from the backend are 0..1 FRACTIONS. Nothing in this file multiplies by 100 except
 * `formatRate`; treating a rate as a percentage anywhere else is the bug this comment exists
 * to prevent.
 */

/** Below this many evaluations a variant's rates are noise, so we make no claims about it. */
export const MIN_SAMPLES = 30

/** A variant's error rate must be this many times the calmest variant's before we call it out. */
const ERROR_MULTIPLE = 1.5

/** …and at least this far above it in absolute terms, so 0.2% vs 0.1% is not "erroring". */
const ERROR_ABSOLUTE = 0.03

export type RateMetric = 'errorRate' | 'conversionRate'

/** "22.7%". Undefined, NaN and nulls render as an em dash rather than "NaN%". */
export function formatRate(rate: number | null | undefined, digits = 1): string {
  if (rate == null || !Number.isFinite(rate)) return '—'
  return `${(rate * 100).toFixed(digits)}%`
}

/** Compact count for a table cell: 1234 → "1,234". */
export function formatCount(count: number | null | undefined): string {
  if (count == null || !Number.isFinite(count)) return '—'
  return count.toLocaleString()
}

export function totalEvals(totals: readonly VariantStats[]): number {
  return totals.reduce((sum, v) => sum + (Number.isFinite(v.evalCount) ? v.evalCount : 0), 0)
}

export interface RolloutHealth {
  totalEvals: number
  /** Highest conversion rate among variants with enough traffic. Null on a tie or thin data. */
  conversionLeaderId: string | null
  /** Variant carrying the most evaluations. Null when nothing was evaluated. */
  trafficLeaderId: string | null
  /** Variants whose error rate is materially worse than the calmest variant's. */
  errorFlagged: ReadonlySet<string>
}

/**
 * The three judgements the monitor screens make about a set of variants.
 *
 * All of them require `MIN_SAMPLES` evaluations: a variation that has served four requests
 * has no meaningful conversion rate, and badging it "leading" would be a lie the operator
 * might act on. A tie for the lead returns null rather than picking arbitrarily.
 */
export function rolloutHealth(totals: readonly VariantStats[]): RolloutHealth {
  const sampled = totals.filter((v) => v.evalCount >= MIN_SAMPLES)

  let conversionLeaderId: string | null = null
  if (sampled.length >= 2) {
    const best = Math.max(...sampled.map((v) => v.conversionRate))
    const winners = sampled.filter((v) => v.conversionRate === best)
    if (winners.length === 1 && best > 0) conversionLeaderId = winners[0].variationId
  }

  let trafficLeaderId: string | null = null
  const withTraffic = totals.filter((v) => v.evalCount > 0)
  if (withTraffic.length > 0) {
    const most = Math.max(...withTraffic.map((v) => v.evalCount))
    const leaders = withTraffic.filter((v) => v.evalCount === most)
    trafficLeaderId = leaders.length === 1 ? leaders[0].variationId : null
  }

  const errorFlagged = new Set<string>()
  if (sampled.length >= 2) {
    const calmest = Math.min(...sampled.map((v) => v.errorRate))
    for (const variant of sampled) {
      const overMultiple = variant.errorRate >= Math.max(calmest, 0) * ERROR_MULTIPLE
      const overAbsolute = variant.errorRate - calmest >= ERROR_ABSOLUTE
      if (overMultiple && overAbsolute) errorFlagged.add(variant.variationId)
    }
  }

  return { totalEvals: totalEvals(totals), conversionLeaderId, trafficLeaderId, errorFlagged }
}

export interface SeriesPoint {
  bucketStart: string
  /** Null when the variant had no evaluations in this bucket — the line breaks, it does not dip to zero. */
  value: number | null
  evalCount: number
}

export interface VariantSeries {
  variationId: string
  variationName?: string
  points: SeriesPoint[]
}

export interface TimeSeries {
  /** Bucket starts, oldest first — the x axis, shared by every series. */
  labels: string[]
  series: VariantSeries[]
  /** Y-axis ceiling: a "nice" number at or above every plotted value. */
  max: number
}

/** Rounds up to 1, 2 or 5 × a power of ten, so the axis lands on a readable number. */
export function niceCeiling(value: number, floor = 0): number {
  // A NaN reading must not swallow the caller's floor, so it is normalised away first.
  const target = Math.max(Number.isFinite(value) ? value : 0, floor)
  if (target <= 0) return floor > 0 ? floor : 1
  const magnitude = 10 ** Math.floor(Math.log10(target))
  for (const step of [1, 2, 5, 10]) {
    const candidate = step * magnitude
    if (target <= candidate + Number.EPSILON * candidate) return candidate
  }
  return 10 * magnitude
}

/**
 * Pivots the bucket-major response into series-major data the chart can draw, keeping every
 * bucket on the x axis even when a variant is missing from it. Variant order follows first
 * appearance so it matches the colour assignment in `buildSeriesMap`.
 */
export function buildTimeSeries(
  buckets: readonly RolloutStatsBucket[],
  metric: RateMetric | 'evalCount',
): TimeSeries {
  const ordered = [...buckets].sort((a, b) => a.bucketStart.localeCompare(b.bucketStart))
  const labels = ordered.map((b) => b.bucketStart)

  const order: string[] = []
  const names = new Map<string, string | undefined>()
  for (const bucket of ordered) {
    for (const variant of bucket.variants) {
      if (!names.has(variant.variationId)) {
        names.set(variant.variationId, variant.variationName)
        order.push(variant.variationId)
      }
    }
  }

  let observed = 0
  const series: VariantSeries[] = order.map((variationId) => ({
    variationId,
    variationName: names.get(variationId),
    points: ordered.map((bucket) => {
      const variant = bucket.variants.find((v) => v.variationId === variationId)
      if (!variant || variant.evalCount === 0) {
        return { bucketStart: bucket.bucketStart, value: null, evalCount: variant?.evalCount ?? 0 }
      }
      const value = metric === 'evalCount' ? variant.evalCount : variant[metric]
      if (Number.isFinite(value)) observed = Math.max(observed, value)
      return { bucketStart: bucket.bucketStart, value, evalCount: variant.evalCount }
    }),
  }))

  // Rates get a 10% floor so a healthy flat-zero flag does not draw a wildly magnified line.
  const max = metric === 'evalCount' ? niceCeiling(observed, 1) : Math.min(1, niceCeiling(observed, 0.1))
  return { labels, series, max }
}

/** Time windows the monitor screens offer, in hours. */
export const MONITOR_WINDOWS = [
  { hours: 24, label: '24h' },
  { hours: 48, label: '48h' },
  { hours: 168, label: '7d' },
] as const

export function isMonitorWindow(hours: number): boolean {
  return MONITOR_WINDOWS.some((w) => w.hours === hours)
}

/** Parses `?hours=`, falling back to 48h for anything absent or not on the picker. */
export function parseWindowHours(raw: string | null, fallback = 48): number {
  const parsed = Number(raw)
  return Number.isFinite(parsed) && isMonitorWindow(parsed) ? parsed : fallback
}
