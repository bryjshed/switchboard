import { describe, expect, it } from 'vitest'
import {
  MIN_SAMPLES,
  buildTimeSeries,
  formatCount,
  formatRate,
  niceCeiling,
  parseWindowHours,
  rolloutHealth,
  totalEvals,
} from '@/lib/rolloutStats'
import type { RolloutStatsBucket, VariantStats } from '@/types/api'

const variant = (
  variationId: string,
  evalCount: number,
  errorRate: number,
  conversionRate: number,
  variationName?: string,
): VariantStats => ({ variationId, evalCount, errorRate, conversionRate, variationName })

describe('formatRate', () => {
  it('renders a 0..1 fraction as a percentage', () => {
    expect(formatRate(0.226667)).toBe('22.7%')
    expect(formatRate(0.08)).toBe('8.0%')
    expect(formatRate(1)).toBe('100.0%')
    expect(formatRate(0)).toBe('0.0%')
  })

  it('honours the digit count', () => {
    expect(formatRate(0.226667, 0)).toBe('23%')
    expect(formatRate(0.226667, 2)).toBe('22.67%')
  })

  it('never renders NaN% for missing data', () => {
    expect(formatRate(undefined)).toBe('—')
    expect(formatRate(null)).toBe('—')
    expect(formatRate(Number.NaN)).toBe('—')
  })
})

describe('formatCount', () => {
  it('groups thousands and dashes out missing values', () => {
    expect(formatCount(1234)).toBe((1234).toLocaleString())
    expect(formatCount(undefined)).toBe('—')
  })
})

describe('totalEvals', () => {
  it('sums across variants', () => {
    expect(totalEvals([variant('a', 225, 0.08, 0.17), variant('b', 75, 0.22, 0.41)])).toBe(300)
  })

  it('ignores a non-finite count rather than poisoning the total', () => {
    expect(totalEvals([variant('a', 10, 0, 0), variant('b', Number.NaN, 0, 0)])).toBe(10)
  })
})

describe('rolloutHealth', () => {
  // The seeded new-checkout production rollout: the True variation errors at 22.7% against
  // an 8% baseline, but converts better. Both judgements must fire independently.
  const seeded = [
    variant('false-id', 225, 0.08, 0.173333, 'False'),
    variant('true-id', 75, 0.226667, 0.413333, 'True'),
  ]

  it('names the conversion leader', () => {
    expect(rolloutHealth(seeded).conversionLeaderId).toBe('true-id')
  })

  it('names the traffic leader separately from the conversion leader', () => {
    expect(rolloutHealth(seeded).trafficLeaderId).toBe('false-id')
  })

  it('flags the variant erroring well above the calmest one', () => {
    const health = rolloutHealth(seeded)
    expect([...health.errorFlagged]).toEqual(['true-id'])
  })

  it('totals the evaluations', () => {
    expect(rolloutHealth(seeded).totalEvals).toBe(300)
  })

  it('makes no claims about a variant with too little traffic', () => {
    const thin = [
      variant('a', MIN_SAMPLES - 1, 0.0, 0.1),
      variant('b', MIN_SAMPLES - 1, 0.9, 0.9),
    ]
    const health = rolloutHealth(thin)
    expect(health.conversionLeaderId).toBeNull()
    expect(health.errorFlagged.size).toBe(0)
  })

  it('refuses to pick a leader on an exact tie', () => {
    const tied = [variant('a', 100, 0.01, 0.2), variant('b', 100, 0.01, 0.2)]
    const health = rolloutHealth(tied)
    expect(health.conversionLeaderId).toBeNull()
    expect(health.trafficLeaderId).toBeNull()
  })

  it('does not call a variant "leading" when nothing has converted at all', () => {
    const flat = [variant('a', 100, 0, 0), variant('b', 100, 0, 0)]
    expect(rolloutHealth(flat).conversionLeaderId).toBeNull()
  })

  it('ignores a proportionally large but absolutely trivial error difference', () => {
    // 0.4% vs 0.1% is 4x, but nobody should get a destructive badge over 3 requests in 1000.
    const noise = [variant('a', 1000, 0.001, 0.2), variant('b', 1000, 0.004, 0.2)]
    expect(rolloutHealth(noise).errorFlagged.size).toBe(0)
  })

  it('flags a variant erroring when the calmest variant is at exactly zero', () => {
    const clean = [variant('a', 500, 0, 0.2), variant('b', 500, 0.15, 0.2)]
    expect([...rolloutHealth(clean).errorFlagged]).toEqual(['b'])
  })

  it('handles an empty stats set without throwing', () => {
    const health = rolloutHealth([])
    expect(health.totalEvals).toBe(0)
    expect(health.conversionLeaderId).toBeNull()
    expect(health.trafficLeaderId).toBeNull()
    expect(health.errorFlagged.size).toBe(0)
  })

  it('cannot compare a single variant against anything', () => {
    const health = rolloutHealth([variant('a', 500, 0.5, 0.5)])
    expect(health.conversionLeaderId).toBeNull()
    expect(health.errorFlagged.size).toBe(0)
    expect(health.trafficLeaderId).toBe('a')
  })
})

describe('niceCeiling', () => {
  it('rounds up to 1, 2 or 5 times a power of ten', () => {
    expect(niceCeiling(0.226667)).toBe(0.5)
    expect(niceCeiling(0.08)).toBe(0.1)
    expect(niceCeiling(12)).toBe(20)
    expect(niceCeiling(150)).toBe(200)
    expect(niceCeiling(0.5)).toBe(0.5)
  })

  it('never returns zero, which would divide the chart by nothing', () => {
    expect(niceCeiling(0)).toBe(1)
    expect(niceCeiling(0, 0.1)).toBe(0.1)
    expect(niceCeiling(Number.NaN, 0.05)).toBe(0.05)
  })

  it('respects a floor above the observed value', () => {
    expect(niceCeiling(0.001, 0.05)).toBe(0.05)
  })
})

describe('buildTimeSeries', () => {
  const buckets: RolloutStatsBucket[] = [
    {
      bucketStart: '2026-08-21T01:00:00Z',
      variants: [variant('a', 10, 0.1, 0.2, 'A'), variant('b', 5, 0.4, 0.6, 'B')],
    },
    {
      bucketStart: '2026-08-21T00:00:00Z',
      variants: [variant('a', 4, 0.25, 0.5, 'A')],
    },
  ]

  it('sorts buckets oldest first so the x axis reads left to right', () => {
    expect(buildTimeSeries(buckets, 'errorRate').labels).toEqual([
      '2026-08-21T00:00:00Z',
      '2026-08-21T01:00:00Z',
    ])
  })

  it('pivots into one series per variation, in first-appearance order', () => {
    const series = buildTimeSeries(buckets, 'errorRate').series
    expect(series.map((s) => s.variationId)).toEqual(['a', 'b'])
    expect(series[0].variationName).toBe('A')
  })

  it('keeps every bucket on every series, filling absences with a gap not a zero', () => {
    const [, b] = buildTimeSeries(buckets, 'conversionRate').series
    expect(b.points).toHaveLength(2)
    expect(b.points[0].value).toBeNull()
    expect(b.points[1].value).toBe(0.6)
  })

  it('treats a bucket with zero evaluations as a gap', () => {
    const empty: RolloutStatsBucket[] = [
      { bucketStart: '2026-08-21T00:00:00Z', variants: [variant('a', 0, 0, 0)] },
    ]
    expect(buildTimeSeries(empty, 'errorRate').series[0].points[0].value).toBeNull()
  })

  it('scales rates to a nice ceiling with a 10% floor', () => {
    expect(buildTimeSeries(buckets, 'errorRate').max).toBe(0.5)
    const calm: RolloutStatsBucket[] = [
      { bucketStart: '2026-08-21T00:00:00Z', variants: [variant('a', 100, 0, 0)] },
    ]
    expect(buildTimeSeries(calm, 'errorRate').max).toBe(0.1)
  })

  it('never scales a rate axis past 100%', () => {
    const maxed: RolloutStatsBucket[] = [
      { bucketStart: '2026-08-21T00:00:00Z', variants: [variant('a', 100, 1, 1)] },
    ]
    expect(buildTimeSeries(maxed, 'errorRate').max).toBe(1)
  })

  it('plots raw counts when the metric is evalCount', () => {
    const series = buildTimeSeries(buckets, 'evalCount')
    expect(series.series[0].points.map((p) => p.value)).toEqual([4, 10])
    expect(series.max).toBe(10)
  })

  it('returns an empty shape for no buckets rather than throwing', () => {
    const empty = buildTimeSeries([], 'errorRate')
    expect(empty.labels).toEqual([])
    expect(empty.series).toEqual([])
    expect(empty.max).toBeGreaterThan(0)
  })
})

describe('parseWindowHours', () => {
  it('accepts the values the picker offers', () => {
    expect(parseWindowHours('24')).toBe(24)
    expect(parseWindowHours('168')).toBe(168)
  })

  it('falls back for anything absent, junk, or off the picker', () => {
    expect(parseWindowHours(null)).toBe(48)
    expect(parseWindowHours('banana')).toBe(48)
    expect(parseWindowHours('999')).toBe(48)
    expect(parseWindowHours('999', 24)).toBe(24)
  })
})
