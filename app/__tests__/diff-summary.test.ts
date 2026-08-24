import {
  describeClause,
  describeRule,
  describeServeShort,
  labelVariation,
  proposalKindLabel,
  proposalStatusTone,
  summarizeDiff,
  summarizeEnvChange,
} from '@features/ai/lib/diffSummary';
import type {
  FlagChangeDiff,
  FlagDetailResponse,
  FlagEnvConfigResponse,
  FlagTargetingConfig,
} from '@shared/api/types';

const ON = 'var-on';
const OFF = 'var-off';

const VARIATIONS = [
  { id: ON, value: 'true', name: 'True' },
  { id: OFF, value: 'false', name: 'False' },
];

function config(overrides: Partial<FlagTargetingConfig> = {}): FlagTargetingConfig {
  return {
    fallthrough: { variationId: OFF, rollout: [] },
    offVariationId: OFF,
    defaultVariationId: ON,
    individualTargets: [],
    rules: [],
    ...overrides,
  };
}

function envConfig(overrides: Partial<FlagEnvConfigResponse> = {}): FlagEnvConfigResponse {
  return {
    flagId: 'flag-1',
    environmentId: 'env-1',
    envKey: 'production',
    enabled: true,
    killSwitchActive: false,
    config: config(),
    version: 4,
    updatedAt: '2026-08-22T10:00:00Z',
    updatedBy: 'alice@ex.com',
    ...overrides,
  };
}

function flag(overrides: Partial<FlagDetailResponse> = {}): FlagDetailResponse {
  return {
    id: 'flag-1',
    projectId: 'p1',
    key: 'new-checkout',
    name: 'New checkout',
    kind: 'BOOLEAN',
    variations: VARIATIONS,
    tags: [],
    envConfigs: [envConfig()],
    ...overrides,
  };
}

describe('value prose', () => {
  it('labels a variation by name, then value, then a short id', () => {
    expect(labelVariation(VARIATIONS, ON)).toBe('True');
    expect(labelVariation([{ id: ON, value: 'compact' }], ON)).toBe('compact');
    expect(labelVariation(VARIATIONS, 'abcdefgh-9999')).toBe('variation abcdefgh');
    expect(labelVariation(VARIATIONS, undefined)).toBe('nothing');
  });

  it('reads a fixed serve as 100% and a rollout as its weights', () => {
    expect(describeServeShort({ variationId: ON, rollout: [] }, VARIATIONS)).toBe('100% True');
    expect(
      describeServeShort(
        { rollout: [{ variationId: ON, weight: 50 }, { variationId: OFF, weight: 50 }] },
        VARIATIONS,
      ),
    ).toBe('50% True / 50% False');
  });

  it('treats an empty rollout array as a fixed serve, not a rollout', () => {
    // The backend serializes rollout: [] alongside variationId on every fixed
    // fallthrough; reading that as a rollout would print an empty string.
    expect(describeServeShort({ variationId: OFF, rollout: [] }, VARIATIONS)).toBe('100% False');
  });

  it('turns clauses into English', () => {
    expect(describeClause({ attribute: 'platform', op: 'EQUALS', values: ['ios'] })).toBe(
      'platform is ios',
    );
    expect(describeClause({ attribute: 'plan', op: 'IN', values: ['pro', 'team'] })).toBe(
      'plan is one of pro or team',
    );
    expect(describeClause({ attribute: 'email', op: 'STARTS_WITH', values: ['qa-'] })).toBe(
      'email starts with qa-',
    );
    expect(describeClause({ attribute: 'key', op: 'SEGMENT_MATCH', values: ['beta'] })).toBe(
      'in segment beta',
    );
    expect(describeClause({ attribute: 'key', op: 'EQUALS', values: ['u1'] })).toBe(
      'context key is u1',
    );
  });

  it('reads a rule as condition then serve', () => {
    expect(
      describeRule(
        {
          id: 'r1',
          clauses: [{ attribute: 'platform', op: 'EQUALS', values: ['ios'] }],
          serve: { rollout: [{ variationId: ON, weight: 10 }, { variationId: OFF, weight: 90 }] },
        },
        VARIATIONS,
      ),
    ).toBe('platform is ios → serve 10% True / 90% False');
  });

  it('says "everyone" for a rule with no clauses', () => {
    expect(
      describeRule({ id: 'r1', clauses: [], serve: { variationId: ON } }, VARIATIONS),
    ).toBe('everyone → serve 100% True');
  });
});

describe('summarizeDiff — FLAG_CREATE', () => {
  const diff: FlagChangeDiff = {
    kind: 'FLAG_CREATE',
    flagKey: 'dark-mode',
    name: 'Dark mode',
    description: 'Ships the dark theme',
    flagKind: 'BOOLEAN',
    variations: [
      { value: 'true', name: 'On' },
      { value: 'false', name: 'Off' },
    ],
    tags: ['ui'],
    envChanges: [{ envKey: 'dev', enabled: true }],
  };

  it('describes the new flag and the env it turns on', () => {
    const summary = summarizeDiff(diff);
    expect(summary.kindLabel).toBe('Create flag');
    expect(summary.headline).toBe('Create dark-mode in dev');
    expect(summary.hasChanges).toBe(true);

    const created = summary.sections.find((s) => s.title === 'New flag');
    expect(created?.lines.map((l) => l.label)).toEqual([
      'Name',
      'Type',
      'Description',
      'Variations',
      'Tags',
    ]);
    expect(created?.lines.find((l) => l.label === 'Variations')?.after).toBe(
      'On (true), Off (false)',
    );
    // Nothing exists yet, so no line carries a "before".
    expect(created?.lines.every((l) => l.before === undefined)).toBe(true);

    const dev = summary.sections.find((s) => s.envKey === 'dev');
    expect(dev?.lines[0]).toMatchObject({ label: 'Flag', after: 'on', tone: 'added' });
  });
});

describe('summarizeDiff — rollout change on an existing flag', () => {
  const diff: FlagChangeDiff = {
    kind: 'FLAG_UPDATE',
    flagKey: 'new-checkout',
    envChanges: [
      {
        envKey: 'production',
        config: config({
          fallthrough: {
            rollout: [
              { variationId: ON, weight: 50 },
              { variationId: OFF, weight: 50 },
            ],
          },
          rules: [
            {
              id: 'r-new',
              clauses: [{ attribute: 'platform', op: 'EQUALS', values: ['ios'] }],
              serve: { rollout: [{ variationId: ON, weight: 10 }, { variationId: OFF, weight: 90 }] },
            },
          ],
        }),
      },
    ],
  };

  it('shows the fallthrough as before → after against the live config', () => {
    const summary = summarizeDiff(diff, { flag: flag() });
    expect(summary.headline).toBe('Update new-checkout in production');
    const prod = summary.sections.find((s) => s.envKey === 'production');
    expect(prod?.lines.find((l) => l.label === 'Fallthrough')).toEqual({
      label: 'Fallthrough',
      before: '100% False',
      after: '50% True / 50% False',
      tone: 'changed',
    });
  });

  it('calls out an added rule in prose, tinted as an addition', () => {
    const summary = summarizeDiff(diff, { flag: flag() });
    const prod = summary.sections.find((s) => s.envKey === 'production');
    expect(prod?.lines.find((l) => l.label === 'Adds rule')).toEqual({
      label: 'Adds rule',
      after: 'platform is ios → serve 10% True / 90% False',
      tone: 'added',
    });
  });

  it('omits the before side when the current flag is unknown', () => {
    const summary = summarizeDiff(diff);
    const prod = summary.sections.find((s) => s.envKey === 'production');
    expect(prod?.lines.find((l) => l.label === 'Fallthrough')?.before).toBeUndefined();
  });

  it('drops env sections that change nothing', () => {
    const noop: FlagChangeDiff = {
      kind: 'FLAG_UPDATE',
      flagKey: 'new-checkout',
      envChanges: [{ envKey: 'production', enabled: true, config: config() }],
    };
    const summary = summarizeDiff(noop, { flag: flag() });
    expect(summary.sections).toHaveLength(0);
    expect(summary.hasChanges).toBe(false);
  });

  it('reports a removed rule and a shrinking target list', () => {
    const current = flag({
      envConfigs: [
        envConfig({
          config: config({
            rules: [
              { id: 'r-old', clauses: [{ attribute: 'plan', op: 'EQUALS', values: ['pro'] }], serve: { variationId: ON } },
            ],
            individualTargets: [
              { contextKey: 'u1', variationId: ON },
              { contextKey: 'u2', variationId: ON },
            ],
          }),
        }),
      ],
    });
    const section = summarizeEnvChange(
      { envKey: 'production', config: config() },
      current.envConfigs[0],
      VARIATIONS,
    );
    expect(section.lines.find((l) => l.label === 'Removes rule')).toMatchObject({
      before: 'plan is pro → serve 100% True',
      tone: 'removed',
    });
    expect(section.lines.find((l) => l.label === 'Individual targets')).toMatchObject({
      before: '2 targets',
      after: '0 targets',
      tone: 'removed',
    });
  });

  it('flags a kill switch as a removal so it never reads as a routine change', () => {
    const section = summarizeEnvChange(
      { envKey: 'production', killSwitchActive: true },
      envConfig(),
      VARIATIONS,
    );
    expect(section.lines[0]).toEqual({
      label: 'Kill switch',
      before: 'off',
      after: 'active',
      tone: 'removed',
    });
  });
});

describe('summarizeDiff — ROLLBACK and RETIREMENT', () => {
  it('names the version a rollback restores', () => {
    const summary = summarizeDiff({
      kind: 'ROLLBACK',
      flagKey: 'heal-me',
      rollbackToVersion: 7,
      envChanges: [{ envKey: 'production' }],
    });
    expect(summary.headline).toBe('Roll heal-me back to version 7 in production');
    expect(summary.sections.find((s) => s.title === 'Rollback')?.lines[0]).toEqual({
      label: 'Restores',
      after: 'version 7',
      tone: 'changed',
    });
  });

  it('renders a retirement checklist as checklist items, not lines', () => {
    const summary = summarizeDiff({
      kind: 'RETIREMENT',
      flagKey: 'legacy-cart',
      retirementChecklist: ['Remove SDK calls', 'Delete the variation branch'],
    });
    expect(summary.headline).toBe('Retire legacy-cart');
    const section = summary.sections.find((s) => s.title === 'Retirement checklist');
    expect(section?.checklist).toEqual(['Remove SDK calls', 'Delete the variation branch']);
    expect(section?.lines).toHaveLength(0);
  });
});

describe('labels', () => {
  it('maps every kind and status', () => {
    expect(proposalKindLabel('FLAG_UPDATE')).toBe('Update flag');
    expect(proposalStatusTone('DRAFT')).toBe('accent');
    expect(proposalStatusTone('APPLIED')).toBe('success');
    expect(proposalStatusTone('REJECTED')).toBe('error');
    expect(proposalStatusTone('EXPIRED')).toBe('neutral');
  });
});
