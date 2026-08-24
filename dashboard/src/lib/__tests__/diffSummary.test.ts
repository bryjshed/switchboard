import { describe, expect, it } from 'vitest'
import {
  describeClause,
  describeDiffBriefly,
  describeRule,
  describeServe,
  describeTargets,
  summarizeDiff,
  summarizeEnvChange,
  variationLabeller,
} from '@/lib/diffSummary'
import type { ChangeLine } from '@/lib/diffSummary'
import type {
  FlagChangeDiff,
  FlagDetail,
  FlagEnvConfig,
  FlagTargetingConfig,
  Variation,
} from '@/types/api'

const CONTROL = '2769171a-3dd5-48b2-b1c3-f0cbc95f3237'
const COMPACT = 'b78b7b07-8eed-4b49-8861-af7104bb06aa'
const EXPANDED = 'd5453411-6e47-4149-ba4a-9a6b6789b6e2'

const variations: Variation[] = [
  { id: CONTROL, value: 'control', name: 'Control' },
  { id: COMPACT, value: 'compact', name: 'Compact' },
  { id: EXPANDED, value: 'expanded' },
]

const label = variationLabeller(variations)

function config(overrides: Partial<FlagTargetingConfig> = {}): FlagTargetingConfig {
  return {
    individualTargets: [],
    rules: [],
    fallthrough: { rollout: [{ variationId: CONTROL, weight: 100 }] },
    offVariationId: CONTROL,
    defaultVariationId: CONTROL,
    ...overrides,
  }
}

function envConfig(envKey: string, overrides: Partial<FlagEnvConfig> = {}): FlagEnvConfig {
  return {
    flagId: 'flag-id',
    environmentId: `${envKey}-env-id`,
    envKey,
    enabled: true,
    killSwitchActive: false,
    config: config(),
    version: 3,
    updatedAt: '2026-08-20T00:00:00Z',
    updatedBy: 'alice@switchboard.dev',
    ...overrides,
  }
}

function flagDetail(overrides: Partial<FlagDetail> = {}): FlagDetail {
  return {
    id: 'flag-id',
    projectId: 'project-id',
    key: 'planner-v2',
    name: 'Planner v2',
    kind: 'STRING',
    variations,
    tags: ['growth'],
    envConfigs: [envConfig('production')],
    ...overrides,
  }
}

const lineFor = (lines: readonly ChangeLine[], key: string) => lines.find((l) => l.key === key)

// ---------------------------------------------------------------- labelling

describe('variationLabeller', () => {
  it('resolves a UUID reference, which is the form the REST diff carries', () => {
    expect(label(CONTROL)).toBe('Control (control)')
  })

  it('resolves a VALUE reference, which is the form the domain diff carries', () => {
    expect(label('compact')).toBe('Compact (compact)')
  })

  it('uses the bare value when a variation has no name', () => {
    expect(label(EXPANDED)).toBe('expanded')
  })

  it('says so plainly when a UUID no longer resolves', () => {
    expect(label('00000000-0000-0000-0000-000000000000')).toBe('unknown variation')
  })

  it('echoes a non-UUID reference it does not know, rather than hiding it', () => {
    expect(label('some-new-value')).toBe('some-new-value')
  })

  it('falls back to draft variations for a flag that does not exist yet', () => {
    const creating = variationLabeller([], [{ value: 'on', name: 'On' }, { value: 'off' }])
    expect(creating('on')).toBe('On (on)')
    expect(creating('off')).toBe('off')
  })

  it('reads a missing reference as "not set"', () => {
    expect(label(undefined)).toBe('not set')
  })
})

// ---------------------------------------------------------------- prose

describe('describeServe', () => {
  it('describes a single variation as full traffic', () => {
    expect(describeServe({ variationId: COMPACT }, label)).toBe('100% Compact (compact)')
  })

  it('describes a rollout as a percentage split', () => {
    expect(
      describeServe(
        {
          rollout: [
            { variationId: CONTROL, weight: 60 },
            { variationId: COMPACT, weight: 40 },
          ],
        },
        label,
      ),
    ).toBe('60% Control (control) / 40% Compact (compact)')
  })

  it('drops zero-weight arms so the sentence stays readable', () => {
    expect(
      describeServe(
        {
          rollout: [
            { variationId: CONTROL, weight: 100 },
            { variationId: COMPACT, weight: 0 },
          ],
        },
        label,
      ),
    ).toBe('100% Control (control)')
  })

  it('treats an empty rollout array alongside a variationId as a single-variation serve', () => {
    // This is the exact shape the backend serves for a resolved diff.
    expect(describeServe({ rollout: [], variationId: CONTROL }, label)).toBe('100% Control (control)')
  })

  it('reports an unset serve rather than rendering an empty string', () => {
    expect(describeServe(undefined, label)).toBe('not set')
    expect(describeServe({}, label)).toBe('not set')
  })
})

describe('describeClause', () => {
  it('renders each operator as a phrase', () => {
    expect(describeClause({ attribute: 'platform', op: 'EQUALS', values: ['ios'] })).toBe(
      'platform is ios',
    )
    expect(describeClause({ attribute: 'plan', op: 'IN', values: ['pro', 'enterprise'] })).toBe(
      'plan is one of pro, enterprise',
    )
    expect(describeClause({ attribute: 'email', op: 'CONTAINS', values: ['@acme.com'] })).toBe(
      'email contains @acme.com',
    )
    expect(describeClause({ attribute: 'path', op: 'STARTS_WITH', values: ['/admin'] })).toBe(
      'path starts with /admin',
    )
    expect(describeClause({ attribute: 'seg', op: 'SEGMENT_MATCH', values: ['beta'] })).toBe(
      'seg is in segment beta',
    )
    expect(describeClause({ attribute: 'seg', op: 'NOT_SEGMENT_MATCH', values: ['beta'] })).toBe(
      'seg is not in segment beta',
    )
  })

  it('names the context key as "user key" rather than the bare attribute', () => {
    expect(describeClause({ attribute: 'key', op: 'EQUALS', values: ['u-1'] })).toBe(
      'user key is u-1',
    )
  })

  it('does not render an empty value list as a dangling phrase', () => {
    expect(describeClause({ attribute: 'plan', op: 'IN', values: [] })).toBe(
      'plan is one of (nothing)',
    )
  })
})

describe('describeRule', () => {
  it('reads as a condition and a consequence', () => {
    expect(
      describeRule(
        {
          id: 'rule-1',
          clauses: [{ attribute: 'platform', op: 'EQUALS', values: ['ios'] }],
          serve: {
            rollout: [
              { variationId: COMPACT, weight: 10 },
              { variationId: CONTROL, weight: 90 },
            ],
          },
        },
        label,
      ),
    ).toBe('platform is ios → serve 10% Compact (compact) / 90% Control (control)')
  })

  it('joins multiple clauses with "and"', () => {
    expect(
      describeRule(
        {
          id: 'rule-2',
          clauses: [
            { attribute: 'platform', op: 'EQUALS', values: ['ios'] },
            { attribute: 'plan', op: 'IN', values: ['pro'] },
          ],
          serve: { variationId: COMPACT },
        },
        label,
      ),
    ).toBe('platform is ios and plan is one of pro → serve 100% Compact (compact)')
  })
})

describe('describeTargets', () => {
  it('groups keys by the variation they are pinned to', () => {
    expect(
      describeTargets(
        [
          { contextKey: 'u-1', variationId: COMPACT },
          { contextKey: 'u-2', variationId: COMPACT },
          { contextKey: 'u-9', variationId: CONTROL },
        ],
        label,
      ),
    ).toBe('u-1, u-2 → Compact (compact); u-9 → Control (control)')
  })

  it('truncates a long list instead of running off the row', () => {
    expect(
      describeTargets(
        ['a', 'b', 'c', 'd', 'e'].map((contextKey) => ({ contextKey, variationId: CONTROL })),
        label,
      ),
    ).toBe('a, b, c and 2 more → Control (control)')
  })

  it('says "none" for an empty or missing list', () => {
    expect(describeTargets([], label)).toBe('none')
    expect(describeTargets(undefined, label)).toBe('none')
  })
})

// ---------------------------------------------------------------- env changes

describe('summarizeEnvChange', () => {
  it('renders a rollout change as before → after', () => {
    const section = summarizeEnvChange(
      {
        envKey: 'production',
        config: config({
          fallthrough: {
            rollout: [
              { variationId: CONTROL, weight: 50 },
              { variationId: COMPACT, weight: 50 },
            ],
          },
        }),
      },
      envConfig('production'),
      label,
    )
    const line = lineFor(section.lines, 'fallthrough')
    expect(line?.before).toBe('100% Control (control)')
    expect(line?.after).toBe('50% Control (control) / 50% Compact (compact)')
  })

  it('omits a field the change leaves exactly as it is', () => {
    const section = summarizeEnvChange(
      { envKey: 'production', config: config() },
      envConfig('production'),
      label,
    )
    expect(section.lines).toEqual([])
  })

  it('renders every field as an addition when the current config is unknown', () => {
    const section = summarizeEnvChange(
      { envKey: 'dev', enabled: true, config: config() },
      undefined,
      label,
    )
    expect(section.lines.every((l) => l.before === undefined)).toBe(true)
    expect(lineFor(section.lines, 'enabled')?.after).toBe('on')
    expect(lineFor(section.lines, 'fallthrough')?.after).toBe('100% Control (control)')
  })

  it('does not manufacture an "individual targets: none" line for a brand new flag', () => {
    const section = summarizeEnvChange({ envKey: 'dev', config: config() }, undefined, label)
    expect(lineFor(section.lines, 'targets')).toBeUndefined()
  })

  it('tints enabling as ok and disabling as a warning', () => {
    const on = summarizeEnvChange(
      { envKey: 'production', enabled: true },
      envConfig('production', { enabled: false }),
      label,
    )
    expect(lineFor(on.lines, 'enabled')).toMatchObject({ before: 'off', after: 'on', tone: 'ok' })

    const off = summarizeEnvChange({ envKey: 'production', enabled: false }, envConfig('production'), label)
    expect(lineFor(off.lines, 'enabled')).toMatchObject({ before: 'on', after: 'off', tone: 'warning' })
  })

  it('treats activating the kill switch as destructive', () => {
    const section = summarizeEnvChange(
      { envKey: 'production', killSwitchActive: true },
      envConfig('production'),
      label,
    )
    expect(lineFor(section.lines, 'kill')).toMatchObject({
      before: 'clear',
      after: 'active',
      tone: 'destructive',
    })
  })

  it('diffs rules by what they say, not by id — applying mints fresh rule UUIDs', () => {
    const rule = (id: string, values: string[]) => ({
      id,
      clauses: [{ attribute: 'platform', op: 'EQUALS' as const, values }],
      serve: { variationId: COMPACT },
    })
    const section = summarizeEnvChange(
      { envKey: 'production', config: config({ rules: [rule('new-uuid', ['ios'])] }) },
      envConfig('production', { config: config({ rules: [rule('old-uuid', ['ios'])] }) }),
      label,
    )
    // Same rule, different id: no add and no remove.
    expect(section.lines.filter((l) => l.key.startsWith('rule-'))).toEqual([])
  })

  it('reports an added rule as ok and a removed rule as destructive', () => {
    const iosRule = {
      id: 'a',
      clauses: [{ attribute: 'platform', op: 'EQUALS' as const, values: ['ios'] }],
      serve: { variationId: COMPACT },
    }
    const androidRule = {
      id: 'b',
      clauses: [{ attribute: 'platform', op: 'EQUALS' as const, values: ['android'] }],
      serve: { variationId: CONTROL },
    }
    const section = summarizeEnvChange(
      { envKey: 'production', config: config({ rules: [androidRule] }) },
      envConfig('production', { config: config({ rules: [iosRule] }) }),
      label,
    )
    const removed = section.lines.find((l) => l.key.startsWith('rule-remove'))
    const added = section.lines.find((l) => l.key.startsWith('rule-add'))
    expect(removed).toMatchObject({ label: 'Removes rule', tone: 'destructive' })
    expect(removed?.after).toContain('platform is ios')
    expect(added).toMatchObject({ label: 'Adds rule', tone: 'ok' })
    expect(added?.after).toContain('platform is android')
  })

  it('surfaces off and default variation changes', () => {
    const section = summarizeEnvChange(
      {
        envKey: 'production',
        config: config({ offVariationId: COMPACT, defaultVariationId: EXPANDED }),
      },
      envConfig('production'),
      label,
    )
    expect(lineFor(section.lines, 'off')).toMatchObject({
      before: 'Control (control)',
      after: 'Compact (compact)',
    })
    expect(lineFor(section.lines, 'default')?.after).toBe('expanded')
  })
})

// ---------------------------------------------------------------- whole diffs

describe('summarizeDiff — FLAG_CREATE', () => {
  const diff: FlagChangeDiff = {
    kind: 'FLAG_CREATE',
    flagKey: 'checkout-redesign',
    name: 'Checkout redesign',
    description: 'The new one-page checkout',
    flagKind: 'STRING',
    variations: [
      { value: 'control', name: 'Control' },
      { value: 'redesign', name: 'Redesign' },
    ],
    tags: ['checkout'],
    envChanges: [
      {
        envKey: 'dev',
        enabled: true,
        config: {
          individualTargets: [],
          rules: [],
          fallthrough: {
            rollout: [
              { variationId: 'control', weight: 90 },
              { variationId: 'redesign', weight: 10 },
            ],
          },
          offVariationId: 'control',
          defaultVariationId: 'control',
        },
      },
    ],
  }

  it('describes the flag it would create, with no invented before values', () => {
    const summary = summarizeDiff(diff, null)
    expect(summary.flagLines.every((l) => l.before === undefined)).toBe(true)
    expect(lineFor(summary.flagLines, 'kind')?.after).toBe('multivariate')
    expect(lineFor(summary.flagLines, 'name')?.after).toBe('Checkout redesign')
    expect(lineFor(summary.flagLines, 'variations')?.after).toBe(
      'Control (control), Redesign (redesign)',
    )
    expect(lineFor(summary.flagLines, 'tags')?.after).toBe('checkout')
  })

  it('resolves the value-keyed targeting against the variations it is about to create', () => {
    const summary = summarizeDiff(diff, null)
    expect(summary.envSections).toHaveLength(1)
    expect(lineFor(summary.envSections[0].lines, 'fallthrough')?.after).toBe(
      '90% Control (control) / 10% Redesign (redesign)',
    )
  })

  it('is not empty', () => {
    expect(summarizeDiff(diff, null).isEmpty).toBe(false)
  })
})

describe('summarizeDiff — FLAG_UPDATE (the monitor rollback shape)', () => {
  // The exact shape the seeded switchboard-monitor proposal carries: a fully resolved,
  // UUID-keyed config that returns all traffic to the baseline variation.
  const diff: FlagChangeDiff = {
    kind: 'FLAG_UPDATE',
    flagKey: 'planner-v2',
    name: 'Planner v2',
    variations: [],
    tags: [],
    retirementChecklist: [],
    envChanges: [
      {
        envKey: 'production',
        config: {
          individualTargets: [],
          rules: [],
          fallthrough: { rollout: [], variationId: CONTROL },
          offVariationId: CONTROL,
          defaultVariationId: CONTROL,
        },
      },
    ],
  }

  const current = flagDetail({
    envConfigs: [
      envConfig('production', {
        config: config({
          fallthrough: {
            rollout: [
              { variationId: CONTROL, weight: 60 },
              { variationId: COMPACT, weight: 20 },
              { variationId: EXPANDED, weight: 20 },
            ],
          },
        }),
      }),
    ],
  })

  it('shows the ramp collapsing back to the baseline', () => {
    const summary = summarizeDiff(diff, current)
    const line = lineFor(summary.envSections[0].lines, 'fallthrough')
    expect(line?.before).toBe(
      '60% Control (control) / 20% Compact (compact) / 20% expanded',
    )
    expect(line?.after).toBe('100% Control (control)')
  })

  it('does not restate the name or tags the flag already has', () => {
    expect(summarizeDiff(diff, current).flagLines).toEqual([])
  })

  it('degrades to the proposed state when the flag cannot be read', () => {
    // Without the flag there is nothing to resolve a UUID against, so the line says
    // "unknown variation" rather than quietly inventing a name. DiffPreview pairs this
    // with a header note that the current values are unavailable.
    const summary = summarizeDiff(diff, null)
    const line = lineFor(summary.envSections[0].lines, 'fallthrough')
    expect(line?.before).toBeUndefined()
    expect(line?.after).toBe('100% unknown variation')
  })
})

describe('summarizeDiff — RETIREMENT', () => {
  const diff: FlagChangeDiff = {
    kind: 'RETIREMENT',
    flagKey: 'legacy-search',
    name: 'Legacy search',
    envChanges: [],
    variations: [],
    tags: [],
    retirementChecklist: [
      'Remove every reference to flag legacy-search from application code and SDK calls',
      'Delete the flag in Switchboard once no service reads it',
      'Notify the team that legacy-search is retired',
    ],
  }

  it('carries the checklist through as a checklist', () => {
    const summary = summarizeDiff(diff, flagDetail({ key: 'legacy-search', name: 'Legacy search' }))
    expect(summary.retirementChecklist).toHaveLength(3)
    expect(summary.envSections).toEqual([])
    expect(summary.isEmpty).toBe(false)
  })

  it('does not report the unchanged name as a change', () => {
    const summary = summarizeDiff(diff, flagDetail({ key: 'legacy-search', name: 'Legacy search' }))
    expect(lineFor(summary.flagLines, 'name')).toBeUndefined()
  })

  it('reads as a retirement in the one-line gist', () => {
    const summary = summarizeDiff(diff, null)
    expect(describeDiffBriefly(summary)).toBe('Retire legacy-search — 3 step checklist')
  })
})

describe('summarizeDiff — ROLLBACK', () => {
  const diff: FlagChangeDiff = {
    kind: 'ROLLBACK',
    flagKey: 'new-checkout',
    rollbackToVersion: 4,
    envChanges: [],
    variations: [],
    tags: [],
  }

  it('keeps the target version and is never counted as empty', () => {
    const summary = summarizeDiff(diff, null)
    expect(summary.rollbackToVersion).toBe(4)
    expect(summary.isEmpty).toBe(false)
    expect(describeDiffBriefly(summary)).toBe('Roll new-checkout back to v4')
  })
})

describe('summarizeDiff — no-op', () => {
  it('reports a diff that would change nothing as empty', () => {
    const diff: FlagChangeDiff = {
      kind: 'FLAG_UPDATE',
      flagKey: 'planner-v2',
      envChanges: [{ envKey: 'production', config: config() }],
      variations: [],
      tags: [],
      retirementChecklist: [],
    }
    const summary = summarizeDiff(diff, flagDetail())
    expect(summary.isEmpty).toBe(true)
    expect(describeDiffBriefly(summary)).toBe('No change to planner-v2')
  })

  it('survives a diff with no envChanges array at all', () => {
    const summary = summarizeDiff({ kind: 'FLAG_UPDATE', flagKey: 'x' }, null)
    expect(summary.envSections).toEqual([])
    expect(summary.isEmpty).toBe(true)
  })
})

describe('describeDiffBriefly', () => {
  it('leads with the environment and the first change', () => {
    const summary = summarizeDiff(
      {
        kind: 'FLAG_UPDATE',
        flagKey: 'planner-v2',
        envChanges: [{ envKey: 'production', killSwitchActive: true }],
      },
      flagDetail(),
    )
    expect(describeDiffBriefly(summary)).toBe('production: Kill switch clear → active')
  })
})
