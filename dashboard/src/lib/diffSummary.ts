import type {
  Clause,
  ClauseOp,
  EnvChange,
  FlagChangeDiff,
  FlagDetail,
  FlagEnvConfig,
  FlagTargetingConfig,
  IndividualTarget,
  ProposalKind,
  RolloutOrVariation,
  Rule,
  Variation,
  VariationCreate,
} from '@/types/api'

/**
 * Turns a typed `FlagChangeDiff` into a readable change summary — the trust surface a
 * reviewer reads instead of raw JSON before applying a proposal.
 *
 * Two things make this harder than it looks, and both are handled here rather than in the
 * component:
 *
 *  - **Variation references.** The domain diff names variations by VALUE; the REST diff
 *    the backend serves has already been resolved against the flag's current head, so it
 *    names them by UUID. Every lookup here therefore tries id first, then value, so the
 *    summary is correct whichever form arrives.
 *  - **Before values.** A diff states an intent, not a delta. "Before" is only knowable when
 *    the flag already exists and we were handed its current config; a FLAG_CREATE, or an
 *    environment with no head yet, legitimately has no before. Those lines render as an
 *    addition rather than inventing a previous value.
 *
 * Rules are diffed by their rendered description, not by id: applying a proposal mints fresh
 * rule UUIDs, so ids never match across a before/after pair and an id-based diff would
 * report every rule as both removed and added.
 */

export type ChangeTone = 'neutral' | 'ok' | 'destructive' | 'warning'

export interface ChangeLine {
  /** Stable within its section; used as a React key. */
  key: string
  label: string
  /** Absent when the current value is not knowable — the line is a pure addition. */
  before?: string
  after: string
  tone: ChangeTone
}

export interface EnvSection {
  envKey: string
  lines: ChangeLine[]
}

export interface DiffSummary {
  kind: ProposalKind
  flagKey: string
  /** Changes to the flag itself: name, description, type, variations, tags. */
  flagLines: ChangeLine[]
  envSections: EnvSection[]
  retirementChecklist: string[]
  rollbackToVersion?: number
  /** True when the diff carries nothing renderable — the caller shows a "no change" note. */
  isEmpty: boolean
}

export const KIND_LABELS: Record<ProposalKind, string> = {
  FLAG_CREATE: 'Create flag',
  FLAG_UPDATE: 'Update flag',
  ROLLBACK: 'Roll back',
  RETIREMENT: 'Retire flag',
}

// ---------------------------------------------------------------- variation labels

export type VariationLabeller = (ref: string | undefined) => string

/**
 * id-or-value → human label. `name (value)` when a variation has both, so a reviewer can
 * see the literal the SDK will return as well as the friendly name.
 */
export function variationLabeller(
  variations: readonly Variation[] = [],
  drafts: readonly VariationCreate[] = [],
): VariationLabeller {
  const byRef = new Map<string, string>()
  const put = (ref: string | undefined, label: string) => {
    if (ref && !byRef.has(ref)) byRef.set(ref, label)
  }
  for (const variation of variations) {
    const label = labelOf(variation.name, variation.value)
    put(variation.id, label)
    put(variation.value, label)
  }
  for (const draft of drafts) {
    put(draft.value, labelOf(draft.name, draft.value))
  }
  return (ref) => {
    if (!ref) return 'not set'
    return byRef.get(ref) ?? (isUuid(ref) ? 'unknown variation' : ref)
  }
}

function labelOf(name: string | undefined, value: string): string {
  const trimmed = name?.trim()
  return trimmed && trimmed !== value ? `${trimmed} (${value})` : value
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isUuid(value: string): boolean {
  return UUID_RE.test(value)
}

// ---------------------------------------------------------------- prose

/** "60% Control / 40% Variant", or just the variation label when it serves one thing. */
export function describeServe(
  serve: RolloutOrVariation | undefined,
  label: VariationLabeller,
): string {
  if (!serve) return 'not set'
  const rollout = serve.rollout ?? []
  if (rollout.length > 0) {
    const visible = rollout.some((w) => w.weight > 0) ? rollout.filter((w) => w.weight > 0) : rollout
    return visible.map((w) => `${w.weight}% ${label(w.variationId)}`).join(' / ')
  }
  if (serve.variationId) return `100% ${label(serve.variationId)}`
  return 'not set'
}

// Phrased for a sentence, so a diff reads as prose: "platform is one of ios, android".
// Exhaustive over ClauseOp on purpose — adding an operator without a phrase here is a compile
// error rather than a diff that falls back to shouting the enum name at a reviewer.
const CLAUSE_PHRASES: Record<ClauseOp, string> = {
  EQUALS: 'is',
  IN: 'is one of',
  CONTAINS: 'contains',
  STARTS_WITH: 'starts with',
  ENDS_WITH: 'ends with',
  MATCHES: 'matches',
  GREATER_THAN: 'is greater than',
  GREATER_THAN_OR_EQUAL: 'is at least',
  LESS_THAN: 'is less than',
  LESS_THAN_OR_EQUAL: 'is at most',
  BEFORE: 'is before',
  AFTER: 'is after',
  SEMVER_EQUAL: 'version is',
  SEMVER_GREATER_THAN: 'version is greater than',
  SEMVER_LESS_THAN: 'version is less than',
  SEGMENT_MATCH: 'is in segment',
  NOT_SEGMENT_MATCH: 'is not in segment',
}

/** "platform is one of ios, android". The context key reads as "user key", not "key". */
export function describeClause(clause: Clause): string {
  const attribute = clause.attribute === 'key' ? 'user key' : clause.attribute
  const values = clause.values.length > 0 ? clause.values.join(', ') : '(nothing)'
  const phrase = CLAUSE_PHRASES[clause.op] ?? clause.op
  // "is not", "does not contain" — negation has to be visible in a diff, or a reviewer approves
  // the exact opposite of what they read.
  const negated = clause.negate ? `NOT ${phrase}` : phrase
  return `${attribute} ${negated} ${values}`
}

/** "platform is ios and plan is one of pro → serve 10% Variant / 90% Control". */
export function describeRule(rule: Rule, label: VariationLabeller): string {
  const when = rule.clauses.map(describeClause).join(' and ')
  return `${when || 'anyone'} → serve ${describeServe(rule.serve, label)}`
}

/** "user-1, user-2 → Variant; user-9 → Control", truncated once it stops being readable. */
export function describeTargets(
  targets: readonly IndividualTarget[] | undefined,
  label: VariationLabeller,
): string {
  if (!targets || targets.length === 0) return 'none'
  const byVariation = new Map<string, string[]>()
  for (const target of targets) {
    const keys = byVariation.get(target.variationId) ?? []
    keys.push(target.contextKey)
    byVariation.set(target.variationId, keys)
  }
  return [...byVariation.entries()]
    .map(([variationId, keys]) => {
      const shown = keys.slice(0, 3).join(', ')
      const rest = keys.length > 3 ? ` and ${keys.length - 3} more` : ''
      return `${shown}${rest} → ${label(variationId)}`
    })
    .join('; ')
}

function describeRules(rules: readonly Rule[] | undefined, label: VariationLabeller): string[] {
  return (rules ?? []).map((rule) => describeRule(rule, label))
}

// ---------------------------------------------------------------- line building

function line(
  key: string,
  label: string,
  before: string | undefined,
  after: string,
  tone: ChangeTone = 'neutral',
): ChangeLine {
  return before === undefined ? { key, label, after, tone } : { key, label, before, after, tone }
}

/**
 * Field-by-field comparison of one environment's slice. `current` is the live config for
 * that environment when we have it; without it every changed field renders as an addition.
 */
export function summarizeEnvChange(
  change: EnvChange,
  current: FlagEnvConfig | undefined,
  label: VariationLabeller,
): EnvSection {
  const lines: ChangeLine[] = []
  const currentConfig: FlagTargetingConfig | undefined = current?.config

  if (change.enabled != null && change.enabled !== current?.enabled) {
    lines.push(
      line(
        'enabled',
        'Flag',
        current ? (current.enabled ? 'on' : 'off') : undefined,
        change.enabled ? 'on' : 'off',
        change.enabled ? 'ok' : 'warning',
      ),
    )
  }

  if (change.killSwitchActive != null && change.killSwitchActive !== current?.killSwitchActive) {
    lines.push(
      line(
        'kill',
        'Kill switch',
        current ? (current.killSwitchActive ? 'active' : 'clear') : undefined,
        change.killSwitchActive ? 'active' : 'clear',
        change.killSwitchActive ? 'destructive' : 'ok',
      ),
    )
  }

  const next = change.config
  if (next) {
    const nextFallthrough = describeServe(next.fallthrough, label)
    const currentFallthrough = currentConfig
      ? describeServe(currentConfig.fallthrough, label)
      : undefined
    if (nextFallthrough !== currentFallthrough) {
      lines.push(line('fallthrough', 'Fallthrough', currentFallthrough, nextFallthrough))
    }

    const beforeRules = currentConfig ? describeRules(currentConfig.rules, label) : null
    const afterRules = describeRules(next.rules, label)
    if (beforeRules === null) {
      afterRules.forEach((text, i) => {
        lines.push(line(`rule-add-${i}`, 'Rule', undefined, text, 'ok'))
      })
    } else {
      const removed = beforeRules.filter((text) => !afterRules.includes(text))
      const added = afterRules.filter((text) => !beforeRules.includes(text))
      removed.forEach((text, i) => {
        lines.push({ key: `rule-remove-${i}`, label: 'Removes rule', after: text, tone: 'destructive' })
      })
      added.forEach((text, i) => {
        lines.push({ key: `rule-add-${i}`, label: 'Adds rule', after: text, tone: 'ok' })
      })
    }

    const nextTargets = describeTargets(next.individualTargets, label)
    const currentTargets = currentConfig
      ? describeTargets(currentConfig.individualTargets, label)
      : undefined
    if (nextTargets !== currentTargets && !(currentConfig === undefined && nextTargets === 'none')) {
      lines.push(line('targets', 'Individual targets', currentTargets, nextTargets))
    }

    const nextOff = label(next.offVariationId)
    const currentOff = currentConfig ? label(currentConfig.offVariationId) : undefined
    if (nextOff !== currentOff) lines.push(line('off', 'Serves when off', currentOff, nextOff))

    const nextDefault = label(next.defaultVariationId)
    const currentDefault = currentConfig ? label(currentConfig.defaultVariationId) : undefined
    if (nextDefault !== currentDefault) {
      lines.push(line('default', 'Default variation', currentDefault, nextDefault))
    }
  }

  return { envKey: change.envKey, lines }
}

function summarizeFlagFields(diff: FlagChangeDiff, flag: FlagDetail | null): ChangeLine[] {
  const lines: ChangeLine[] = []
  const isCreate = diff.kind === 'FLAG_CREATE'

  if (diff.flagKind && diff.flagKind !== flag?.kind) {
    const describe = (kind: string) => (kind === 'STRING' ? 'multivariate' : 'boolean')
    lines.push(
      line('kind', 'Flag type', flag ? describe(flag.kind) : undefined, describe(diff.flagKind)),
    )
  }
  if (diff.name != null && diff.name !== flag?.name) {
    lines.push(line('name', 'Name', flag?.name, diff.name))
  }
  if (diff.description != null && diff.description !== (flag?.description ?? '')) {
    lines.push(line('description', 'Description', flag?.description, diff.description))
  }

  const variations = diff.variations ?? []
  if (variations.length > 0) {
    const after = variations.map((v) => labelOf(v.name, v.value)).join(', ')
    // On an update, variations are add-only, so listing the existing set as "before" is
    // honest; on a create there is nothing to compare against.
    const before =
      !isCreate && flag ? flag.variations.map((v) => labelOf(v.name, v.value)).join(', ') : undefined
    if (after !== before) lines.push(line('variations', 'Variations', before, after, 'ok'))
  }

  const tags = diff.tags ?? []
  if (tags.length > 0) {
    const after = tags.join(', ')
    const before = flag ? flag.tags.join(', ') : undefined
    if (after !== before) lines.push(line('tags', 'Tags', before, after))
  }

  return lines
}

/**
 * The whole readable summary. `flag` is the current state of the flag the diff edits, when
 * it exists — pass null for a FLAG_CREATE or when the fetch failed, and every line degrades
 * to an addition rather than disappearing.
 */
export function summarizeDiff(diff: FlagChangeDiff, flag: FlagDetail | null): DiffSummary {
  const label = variationLabeller(flag?.variations ?? [], diff.variations ?? [])
  const configByEnv = new Map((flag?.envConfigs ?? []).map((c) => [c.envKey, c]))

  const flagLines = summarizeFlagFields(diff, flag)
  const envSections = (diff.envChanges ?? [])
    .map((change) => summarizeEnvChange(change, configByEnv.get(change.envKey), label))
    .filter((section) => section.lines.length > 0)
  const retirementChecklist = diff.retirementChecklist ?? []

  return {
    kind: diff.kind,
    flagKey: diff.flagKey,
    flagLines,
    envSections,
    retirementChecklist,
    rollbackToVersion: diff.rollbackToVersion,
    isEmpty:
      flagLines.length === 0 &&
      envSections.length === 0 &&
      retirementChecklist.length === 0 &&
      diff.rollbackToVersion == null,
  }
}

/** One-line gist for a list row: what the proposal would do, without the detail. */
export function describeDiffBriefly(summary: DiffSummary): string {
  if (summary.kind === 'RETIREMENT') {
    return `Retire ${summary.flagKey} — ${summary.retirementChecklist.length} step checklist`
  }
  if (summary.rollbackToVersion != null) {
    return `Roll ${summary.flagKey} back to v${summary.rollbackToVersion}`
  }
  const first = summary.envSections[0]?.lines[0] ?? summary.flagLines[0]
  if (!first) return `No change to ${summary.flagKey}`
  const env = summary.envSections[0] ? `${summary.envSections[0].envKey}: ` : ''
  return first.before === undefined
    ? `${env}${first.label} ${first.after}`
    : `${env}${first.label} ${first.before} → ${first.after}`
}
