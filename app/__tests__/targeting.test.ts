import {
  clampPercent,
  describeServe,
  isRollout,
  isTwoWayRamp,
  isValidFlagKey,
  isValidRollout,
  isValidServe,
  rampPercentage,
  rolloutSum,
  slugifyKey,
  snapToDetent,
  withRampPercent,
} from '@features/flags/lib/targeting';
import {
  isDirty,
  targetingError,
  targetingReducer,
  type TargetingDraft,
} from '@features/flags/lib/targetingReducer';
import type { FlagTargetingConfig, Variation } from '@shared/api/types';

const TRUE_ID = 'var-true';
const FALSE_ID = 'var-false';

const VARIATIONS: Variation[] = [
  { id: TRUE_ID, value: 'true', name: 'True' },
  { id: FALSE_ID, value: 'false', name: 'False' },
];

const fixedConfig: FlagTargetingConfig = {
  // The backend serializes an empty rollout alongside a fixed variationId.
  fallthrough: { variationId: TRUE_ID, rollout: [] },
  offVariationId: FALSE_ID,
  defaultVariationId: TRUE_ID,
  individualTargets: [],
  rules: [],
};

const rampedConfig: FlagTargetingConfig = {
  ...fixedConfig,
  fallthrough: {
    rollout: [
      { variationId: TRUE_ID, weight: 25 },
      { variationId: FALSE_ID, weight: 75 },
    ],
  },
};

describe('rollout weights', () => {
  it('sums weights', () => {
    expect(rolloutSum(rampedConfig.fallthrough.rollout)).toBe(100);
    expect(rolloutSum([{ variationId: TRUE_ID, weight: 30 }])).toBe(30);
    expect(rolloutSum(undefined)).toBe(0);
  });

  it('accepts only integer weights totalling exactly 100 across 2+ rows', () => {
    expect(isValidRollout(rampedConfig.fallthrough.rollout)).toBe(true);
    expect(
      isValidRollout([
        { variationId: TRUE_ID, weight: 30 },
        { variationId: FALSE_ID, weight: 60 },
      ]),
    ).toBe(false);
    expect(
      isValidRollout([
        { variationId: TRUE_ID, weight: 30 },
        { variationId: FALSE_ID, weight: 80 },
      ]),
    ).toBe(false);
    expect(
      isValidRollout([
        { variationId: TRUE_ID, weight: 50.5 },
        { variationId: FALSE_ID, weight: 49.5 },
      ]),
    ).toBe(false);
    expect(
      isValidRollout([
        { variationId: TRUE_ID, weight: -10 },
        { variationId: FALSE_ID, weight: 110 },
      ]),
    ).toBe(false);
    expect(isValidRollout([{ variationId: TRUE_ID, weight: 100 }])).toBe(false);
  });

  it('never reads an empty rollout array as a rollout', () => {
    expect(isRollout(fixedConfig.fallthrough)).toBe(false);
    expect(isRollout(rampedConfig.fallthrough)).toBe(true);
    expect(isValidServe(fixedConfig.fallthrough)).toBe(true);
  });
});

describe('ramp percentage', () => {
  it('reads the DEFAULT variation weight, matching the backend summary', () => {
    expect(rampPercentage(rampedConfig)).toBe(25);
    expect(rampPercentage(fixedConfig)).toBeNull();
    expect(isTwoWayRamp(rampedConfig)).toBe(true);
    expect(isTwoWayRamp(fixedConfig)).toBe(false);
  });

  it('rewrites the fallthrough so the pair always totals 100', () => {
    const next = withRampPercent(rampedConfig, 75);
    expect(next.fallthrough.rollout).toEqual([
      { variationId: TRUE_ID, weight: 75 },
      { variationId: FALSE_ID, weight: 25 },
    ]);
    expect(rolloutSum(next.fallthrough.rollout)).toBe(100);
  });

  it('converts a fixed fallthrough into a ramp against the off variation', () => {
    const next = withRampPercent(fixedConfig, 10);
    expect(next.fallthrough.rollout).toEqual([
      { variationId: TRUE_ID, weight: 10 },
      { variationId: FALSE_ID, weight: 90 },
    ]);
  });

  it('clamps and snaps to detents', () => {
    expect(clampPercent(140)).toBe(100);
    expect(clampPercent(-3)).toBe(0);
    expect(snapToDetent(37)).toBe(25);
    expect(snapToDetent(38)).toBe(50);
    expect(snapToDetent(97)).toBe(100);
  });
});

describe('describeServe', () => {
  it('names a fixed variation and spells out a rollout', () => {
    expect(describeServe(fixedConfig.fallthrough, VARIATIONS)).toBe('Serves True');
    expect(describeServe(rampedConfig.fallthrough, VARIATIONS)).toBe('25% True / 75% False');
  });
});

describe('slugifyKey', () => {
  it('produces backend-legal keys', () => {
    expect(slugifyKey('New checkout')).toBe('new-checkout');
    expect(slugifyKey('  AI  suggestions v2 ')).toBe('ai-suggestions-v2');
    expect(slugifyKey('2026 rollout')).toBe('rollout');
    expect(slugifyKey('!!!')).toBe('');
    expect(isValidFlagKey('new-checkout')).toBe(true);
    expect(isValidFlagKey('New-Checkout')).toBe(false);
    expect(isValidFlagKey('-leading')).toBe(false);
  });
});

describe('targeting reducer', () => {
  const draft: TargetingDraft = { enabled: true, config: fixedConfig };

  it('adds a rule with a UUID id (the backend parses rule ids as UUIDs)', () => {
    const next = targetingReducer(draft, { type: 'addRule' });
    expect(next.config.rules).toHaveLength(1);
    expect(next.config.rules?.[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    // The original draft is untouched.
    expect(draft.config.rules).toHaveLength(0);
  });

  it('blocks saving until every clause and serve is complete', () => {
    const withRule = targetingReducer(draft, { type: 'addRule' });
    const ruleId = withRule.config.rules![0].id;
    expect(targetingError(withRule)).toBe('Every clause needs an attribute');

    const withAttribute = targetingReducer(withRule, {
      type: 'updateClause',
      ruleId,
      index: 0,
      patch: { attribute: 'plan' },
    });
    expect(targetingError(withAttribute)).toBe('Every clause needs a value');

    const withValue = targetingReducer(withAttribute, {
      type: 'updateClause',
      ruleId,
      index: 0,
      patch: { values: ['pro'] },
    });
    expect(targetingError(withValue)).toBeNull();

    const badRollout = targetingReducer(withValue, {
      type: 'updateRule',
      ruleId,
      patch: {
        serve: {
          rollout: [
            { variationId: TRUE_ID, weight: 60 },
            { variationId: FALSE_ID, weight: 60 },
          ],
        },
      },
    });
    expect(targetingError(badRollout)).toBe('Rule rollout weights must total 100');
  });

  it('ignores the empty-vs-absent noise the backend round-trips when checking dirty', () => {
    const loaded: TargetingDraft = { enabled: true, config: fixedConfig };
    const sameShapeDifferentEncoding: TargetingDraft = {
      enabled: true,
      config: {
        fallthrough: { variationId: TRUE_ID },
        offVariationId: FALSE_ID,
        defaultVariationId: TRUE_ID,
      },
    };
    expect(isDirty(sameShapeDifferentEncoding, loaded)).toBe(false);
    expect(isDirty(targetingReducer(loaded, { type: 'setEnabled', enabled: false }), loaded)).toBe(
      true,
    );
  });
});
