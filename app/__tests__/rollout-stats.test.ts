import {
  activeRollouts,
  erroringVariationIds,
  errorTrend,
  formatCount,
  formatRate,
  leadingVariationId,
  seriesTrend,
  totalEvals,
  variantSeries,
  windowHours,
} from '@features/ai/lib/rolloutStats';
import type { FlagSummaryResponse, VariantStats } from '@shared/api/types';

const A = 'var-a';
const B = 'var-b';

const variant = (id: string, over: Partial<VariantStats> = {}): VariantStats => ({
  variationId: id,
  evalCount: 100,
  errorRate: 0.01,
  conversionRate: 0.1,
  ...over,
});

describe('formatting', () => {
  it('renders rates as percentages and counts compactly', () => {
    expect(formatRate(0.2)).toBe('20.0%');
    expect(formatRate(0.018182)).toBe('1.8%');
    expect(formatCount(400)).toBe('400');
    expect(formatCount(1500)).toBe('1.5k');
    expect(formatCount(24000)).toBe('24k');
    expect(formatCount(2_400_000)).toBe('2.4M');
  });

  it('maps window choices to the ?hours= parameter', () => {
    expect(windowHours('24')).toBe(24);
    expect(windowHours('48')).toBe(48);
    expect(windowHours('168')).toBe(168);
  });
});

describe('verdicts', () => {
  it('names the conversion leader only when there is a clear winner', () => {
    expect(
      leadingVariationId([
        variant(A, { conversionRate: 0.1 }),
        variant(B, { conversionRate: 0.3 }),
      ]),
    ).toBe(B);
    // A tie is not a lead.
    expect(
      leadingVariationId([
        variant(A, { conversionRate: 0.2 }),
        variant(B, { conversionRate: 0.2 }),
      ]),
    ).toBeNull();
    // Nothing to compare against.
    expect(leadingVariationId([variant(A)])).toBeNull();
    expect(leadingVariationId([])).toBeNull();
  });

  it('flags a variant erroring well above its peers, and only then', () => {
    expect(
      erroringVariationIds([
        variant(A, { errorRate: 0.018 }),
        variant(B, { errorRate: 0.2 }),
      ]),
    ).toEqual([B]);
    // 2.5% vs 2.0% is neither 2x nor 2 points apart.
    expect(
      erroringVariationIds([
        variant(A, { errorRate: 0.02 }),
        variant(B, { errorRate: 0.025 }),
      ]),
    ).toEqual([]);
    // A variant with no traffic cannot be judged.
    expect(
      erroringVariationIds([
        variant(A, { errorRate: 0.0 }),
        variant(B, { errorRate: 0.5, evalCount: 0 }),
      ]),
    ).toEqual([]);
  });

  it('sums evaluations across variants', () => {
    expect(totalEvals([variant(A, { evalCount: 400 }), variant(B, { evalCount: 200 })])).toBe(600);
  });
});

describe('trends', () => {
  it('reads the second half of the window against the first', () => {
    expect(seriesTrend([0.01, 0.01, 0.2, 0.2])).toBe('up');
    expect(seriesTrend([0.2, 0.2, 0.01, 0.01])).toBe('down');
    expect(seriesTrend([0.1, 0.1, 0.1, 0.1])).toBe('flat');
  });

  it('calls ordinary noise flat rather than a trend', () => {
    expect(seriesTrend([0.1, 0.1, 0.104, 0.103])).toBe('flat');
  });

  it('needs at least two buckets', () => {
    expect(seriesTrend([])).toBe('flat');
    expect(seriesTrend([0.5])).toBe('flat');
  });

  it('pulls one variant out of the bucket series', () => {
    const buckets = [
      { bucketStart: '2026-08-22T19:00:00Z', variants: [variant(A, { errorRate: 0.01 })] },
      {
        bucketStart: '2026-08-22T20:00:00Z',
        variants: [variant(A, { errorRate: 0.2 }), variant(B, { errorRate: 0.02 })],
      },
    ];
    expect(variantSeries(buckets, A, 'errorRate')).toEqual([0.01, 0.2]);
    // A variant missing from a bucket reads as zero, not a gap.
    expect(variantSeries(buckets, B, 'errorRate')).toEqual([0, 0.02]);
  });

  it('surfaces the worst variant trend for the monitor row', () => {
    const stats = {
      flagKey: 'heal-me',
      environmentId: 'e1',
      totals: [variant(A), variant(B)],
      buckets: [
        {
          bucketStart: '1',
          variants: [variant(A, { errorRate: 0.01 }), variant(B, { errorRate: 0.2 })],
        },
        {
          bucketStart: '2',
          variants: [variant(A, { errorRate: 0.2 }), variant(B, { errorRate: 0.01 })],
        },
      ],
    };
    expect(errorTrend(stats)).toBe('up');
    expect(errorTrend(undefined)).toBe('flat');
  });
});

describe('activeRollouts', () => {
  const flags: FlagSummaryResponse[] = [
    {
      id: '1',
      key: 'optimize-me',
      name: 'Optimize me',
      kind: 'BOOLEAN',
      tags: [],
      environments: [
        { envKey: 'dev', enabled: false, killSwitchActive: false, version: 1 },
        {
          envKey: 'production',
          enabled: true,
          killSwitchActive: false,
          version: 4,
          rolloutPercentage: 25,
        },
      ],
    },
    {
      id: '2',
      key: 'heal-me',
      name: 'Heal me',
      kind: 'BOOLEAN',
      tags: [],
      environments: [
        { envKey: 'production', enabled: true, killSwitchActive: false, version: 3 },
      ],
    },
  ];

  it('keeps only flags whose fallthrough is a rollout in that env', () => {
    const rollouts = activeRollouts(flags, 'production');
    expect(rollouts.map((r) => r.flag.key)).toEqual(['optimize-me']);
    expect(rollouts[0]).toMatchObject({ percentage: 25, enabled: true, killSwitchActive: false });
  });

  it('is empty for an env with no rollouts, and without an env at all', () => {
    expect(activeRollouts(flags, 'dev')).toEqual([]);
    expect(activeRollouts(flags, undefined)).toEqual([]);
  });
});
