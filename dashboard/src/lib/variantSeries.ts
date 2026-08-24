/**
 * Colour assignment for per-variation bars, dots and time series.
 *
 * The palette (`--series-1` … `--series-5` in index.css) is categorical and deliberately
 * disjoint from both the state palette (ok / destructive / warning) and the environment
 * identity hues: a variation's colour must never be readable as "healthy", "killed" or
 * "production". Every entry is defined for light AND dark; the dark block re-tunes the same
 * hues upward so a solid bar stays legible on either background.
 *
 * Assignment is positional and therefore DETERMINISTIC for a given ordering: the same
 * variation gets the same colour in the rollout bar, the comparison table, the legend and
 * the chart, on every render and after a refetch. It is not hashed — a hash would collide
 * and would make two variations of the same flag share a colour.
 */

export const SERIES_COUNT = 5

/** 0-based slot in the palette. */
export type SeriesIndex = number

const BAR_CLASSES = [
  'bg-series-1',
  'bg-series-2',
  'bg-series-3',
  'bg-series-4',
  'bg-series-5',
] as const

const CSS_VARS = [
  'var(--series-1)',
  'var(--series-2)',
  'var(--series-3)',
  'var(--series-4)',
  'var(--series-5)',
] as const

/** Wraps rather than throwing: a flag with six variations still renders, it just repeats. */
export function seriesIndex(position: number): SeriesIndex {
  const n = Math.trunc(position)
  return ((n % SERIES_COUNT) + SERIES_COUNT) % SERIES_COUNT
}

/** Tailwind class for a solid fill (bar segment, legend dot) in this series' colour. */
export function seriesBarClass(position: number): string {
  return BAR_CLASSES[seriesIndex(position)]
}

/**
 * `hsl(...)` string for inline SVG, which cannot use Tailwind classes for stroke/fill. Reads
 * the same custom property as the Tailwind class, so themes stay in sync automatically.
 */
export function seriesColorVar(position: number): string {
  return `hsl(${CSS_VARS[seriesIndex(position)]})`
}

/**
 * Stable variationId → palette slot for one flag. Order comes from the caller (the flag's
 * own variation order where it is known, otherwise whatever order the stats arrived in), and
 * an id repeated in the input keeps its FIRST slot so a duplicate cannot shift the rest.
 */
export function buildSeriesMap(variationIds: readonly string[]): Map<string, SeriesIndex> {
  const map = new Map<string, SeriesIndex>()
  for (const id of variationIds) {
    if (!map.has(id)) map.set(id, seriesIndex(map.size))
  }
  return map
}

/** Slot for one id, falling back to slot 0 for an id the map has never seen. */
export function seriesFor(map: Map<string, SeriesIndex>, variationId: string): SeriesIndex {
  return map.get(variationId) ?? 0
}
