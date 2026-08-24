import { describe, expect, it } from 'vitest'
import {
  SERIES_COUNT,
  buildSeriesMap,
  seriesBarClass,
  seriesColorVar,
  seriesFor,
  seriesIndex,
} from '@/lib/variantSeries'

const A = '11111111-1111-1111-1111-111111111111'
const B = '22222222-2222-2222-2222-222222222222'
const C = '33333333-3333-3333-3333-333333333333'

describe('seriesIndex', () => {
  it('is the identity inside the palette', () => {
    expect(seriesIndex(0)).toBe(0)
    expect(seriesIndex(4)).toBe(4)
  })

  it('wraps rather than running off the end of the palette', () => {
    expect(seriesIndex(SERIES_COUNT)).toBe(0)
    expect(seriesIndex(SERIES_COUNT + 2)).toBe(2)
  })

  it('handles a negative position without producing an undefined class', () => {
    expect(seriesIndex(-1)).toBe(SERIES_COUNT - 1)
    expect(seriesBarClass(-1)).toBe('bg-series-5')
  })
})

describe('buildSeriesMap', () => {
  it('assigns slots by position, so the same order always yields the same colours', () => {
    const first = buildSeriesMap([A, B, C])
    const second = buildSeriesMap([A, B, C])
    expect([...first.entries()]).toEqual([
      [A, 0],
      [B, 1],
      [C, 2],
    ])
    expect([...second.entries()]).toEqual([...first.entries()])
  })

  it('is stable across repeated calls with the same input (determinism)', () => {
    const ids = [C, A, B]
    const runs = Array.from({ length: 5 }, () => [...buildSeriesMap(ids).entries()])
    for (const run of runs) expect(run).toEqual(runs[0])
  })

  it('keeps a duplicated id on its first slot so the rest do not shift', () => {
    const map = buildSeriesMap([A, B, A, C])
    expect(map.get(A)).toBe(0)
    expect(map.get(B)).toBe(1)
    expect(map.get(C)).toBe(2)
  })

  it('wraps past the end of the palette rather than dropping variations', () => {
    const ids = Array.from({ length: SERIES_COUNT + 2 }, (_, i) => `v-${i}`)
    const map = buildSeriesMap(ids)
    expect(map.size).toBe(ids.length)
    expect(map.get(`v-${SERIES_COUNT}`)).toBe(0)
  })
})

describe('seriesFor', () => {
  it('falls back to the first slot for an id the map never saw', () => {
    expect(seriesFor(buildSeriesMap([A]), B)).toBe(0)
  })
})

describe('palette bindings', () => {
  it('maps every slot to a defined tailwind class', () => {
    for (let i = 0; i < SERIES_COUNT; i++) {
      expect(seriesBarClass(i)).toBe(`bg-series-${i + 1}`)
    }
  })

  it('resolves SVG colours through the same custom properties, so themes stay in sync', () => {
    for (let i = 0; i < SERIES_COUNT; i++) {
      expect(seriesColorVar(i)).toBe(`hsl(var(--series-${i + 1}))`)
    }
  })

  it('never borrows a state or environment colour for a variation', () => {
    const forbidden = ['ok', 'destructive', 'warning', 'info', 'env-dev', 'env-staging', 'env-production']
    for (let i = 0; i < SERIES_COUNT; i++) {
      const className = seriesBarClass(i)
      for (const token of forbidden) expect(className).not.toBe(`bg-${token}`)
    }
  })
})
