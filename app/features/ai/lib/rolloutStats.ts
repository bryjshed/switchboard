import type {
  FlagSummaryResponse,
  RolloutStatsBucket,
  RolloutStatsResponse,
  VariantStats,
} from '@shared/api/types';

/** Windows the rollout detail can request, mapped to the ?hours= parameter. */
export const STATS_WINDOWS = [
  { value: '24', label: '24h', hours: 24 },
  { value: '48', label: '48h', hours: 48 },
  { value: '168', label: '7d', hours: 168 },
] as const;

export type StatsWindowValue = (typeof STATS_WINDOWS)[number]['value'];

export const DEFAULT_WINDOW: StatsWindowValue = '48';

export function windowHours(value: StatsWindowValue): number {
  return STATS_WINDOWS.find((w) => w.value === value)?.hours ?? 48;
}

/** "20.0%" — rates arrive as 0..1 fractions. */
export function formatRate(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  return `${(rate * 100).toFixed(1)}%`;
}

/** Compact eval counts so a 4-variant row never wraps. */
export function formatCount(count: number): string {
  if (!Number.isFinite(count)) return '0';
  if (count < 1000) return `${count}`;
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function totalEvals(totals: readonly VariantStats[]): number {
  return totals.reduce((sum, v) => sum + (v.evalCount ?? 0), 0);
}

/**
 * Variant with the best conversion rate. Null when nothing has traffic or the
 * top two are tied — "leading" must mean something, so a tie shows no badge.
 */
export function leadingVariationId(totals: readonly VariantStats[]): string | null {
  const withTraffic = totals.filter((v) => v.evalCount > 0);
  if (withTraffic.length < 2) return null;
  const sorted = [...withTraffic].sort((a, b) => b.conversionRate - a.conversionRate);
  if (sorted[0].conversionRate <= 0) return null;
  if (sorted[0].conversionRate === sorted[1].conversionRate) return null;
  return sorted[0].variationId;
}

/** A variant erroring at 2x+ the best variant, and by at least 2 points. */
export const ERROR_RATIO_THRESHOLD = 2;
export const ERROR_ABSOLUTE_THRESHOLD = 0.02;

export function erroringVariationIds(totals: readonly VariantStats[]): string[] {
  const withTraffic = totals.filter((v) => v.evalCount > 0);
  if (withTraffic.length < 2) return [];
  const best = Math.min(...withTraffic.map((v) => v.errorRate));
  return withTraffic
    .filter(
      (v) =>
        v.errorRate - best >= ERROR_ABSOLUTE_THRESHOLD &&
        v.errorRate >= Math.max(best, 0.0001) * ERROR_RATIO_THRESHOLD,
    )
    .map((v) => v.variationId);
}

export type Trend = 'up' | 'down' | 'flat';

/** Per-variant series over the hourly buckets — the sparkline's input. */
export function variantSeries(
  buckets: readonly RolloutStatsBucket[],
  variationId: string,
  metric: 'errorRate' | 'conversionRate' | 'evalCount' = 'errorRate',
): number[] {
  return buckets.map((b) => b.variants.find((v) => v.variationId === variationId)?.[metric] ?? 0);
}

/**
 * Direction of the second half of the window against the first. Flat below a
 * 10% relative move so ordinary noise does not render as a trend arrow.
 */
export function seriesTrend(series: readonly number[], tolerance = 0.1): Trend {
  if (series.length < 2) return 'flat';
  const mid = Math.floor(series.length / 2);
  const mean = (xs: readonly number[]) =>
    xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
  const first = mean(series.slice(0, mid));
  const second = mean(series.slice(mid));
  const delta = second - first;
  const scale = Math.max(Math.abs(first), 1e-6);
  if (Math.abs(delta) / scale < tolerance) return 'flat';
  return delta > 0 ? 'up' : 'down';
}

/** Worst error trend across the flag's variants — the monitor row's indicator. */
export function errorTrend(stats: RolloutStatsResponse | undefined): Trend {
  if (!stats || stats.buckets.length < 2) return 'flat';
  const trends = stats.totals.map((v) =>
    seriesTrend(variantSeries(stats.buckets, v.variationId, 'errorRate')),
  );
  if (trends.includes('up')) return 'up';
  if (trends.includes('down')) return 'down';
  return 'flat';
}

export interface ActiveRollout {
  flag: FlagSummaryResponse;
  envKey: string;
  /** Percent on the default variation, from FlagEnvSummary.rolloutPercentage. */
  percentage: number;
  enabled: boolean;
  killSwitchActive: boolean;
}

/**
 * Flags whose fallthrough is a rollout in this env — derived from the A2 flags
 * list, so the Monitor tab needs no extra request to know what to watch.
 */
export function activeRollouts(
  flags: readonly FlagSummaryResponse[],
  envKey: string | undefined,
): ActiveRollout[] {
  if (!envKey) return [];
  const out: ActiveRollout[] = [];
  flags.forEach((flag) => {
    const env = flag.environments.find((e) => e.envKey === envKey);
    if (!env || env.rolloutPercentage === undefined || env.rolloutPercentage === null) return;
    out.push({
      flag,
      envKey,
      percentage: env.rolloutPercentage,
      enabled: env.enabled,
      killSwitchActive: env.killSwitchActive,
    });
  });
  return out;
}
