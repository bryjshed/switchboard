import { isRollout } from '@features/flags/lib/targeting';
import type {
  Clause,
  EnvChange,
  FlagChangeDiff,
  FlagDetailResponse,
  FlagEnvConfigResponse,
  FlagTargetingConfig,
  ProposalKind,
  ProposalStatus,
  RolloutOrVariation,
  Rule,
  Variation,
  VariationCreate,
} from '@shared/api/types';
import type { BadgeTone } from '@shared/ui';

/**
 * Turns a typed FlagChangeDiff into a readable change summary.
 *
 * This is the trust surface: a human is about to apply an AI-written change to
 * production, so nothing here may render raw JSON. Everything is pure and
 * unit-tested (__tests__/diff-summary.test.ts); the component only lays out
 * what these functions return.
 */

export type DiffTone = 'added' | 'removed' | 'changed' | 'neutral';

export interface DiffLine {
  /** What changed ("Fallthrough", "Kill switch", "Adds rule"). */
  label: string;
  /** Current value, when it is known. Absent for pure additions. */
  before?: string;
  /** Proposed value. Absent when the line describes a removal. */
  after?: string;
  tone: DiffTone;
}

export interface DiffSection {
  title: string;
  /** Set when the section describes one environment's change. */
  envKey?: string;
  lines: DiffLine[];
  /** Retirement checklist items, rendered as checkboxes rather than lines. */
  checklist?: string[];
}

export interface DiffSummary {
  kind: ProposalKind;
  kindLabel: string;
  flagKey: string;
  /** One-line "what this does". */
  headline: string;
  sections: DiffSection[];
  /** False when the diff carries nothing renderable — the UI says so plainly. */
  hasChanges: boolean;
}

export interface DiffContext {
  /** The flag as it exists today. Absent for FLAG_CREATE or an unloaded flag. */
  flag?: FlagDetailResponse;
}

// ---------- labels ----------

export function proposalKindLabel(kind: ProposalKind): string {
  switch (kind) {
    case 'FLAG_CREATE':
      return 'Create flag';
    case 'FLAG_UPDATE':
      return 'Update flag';
    case 'ROLLBACK':
      return 'Roll back';
    case 'RETIREMENT':
      return 'Retire flag';
  }
}

export function proposalStatusLabel(status: ProposalStatus): string {
  switch (status) {
    case 'DRAFT':
      return 'Draft';
    case 'APPLIED':
      return 'Applied';
    case 'REJECTED':
      return 'Rejected';
    case 'EXPIRED':
      return 'Expired';
  }
}

export function proposalStatusTone(status: ProposalStatus): BadgeTone {
  switch (status) {
    case 'DRAFT':
      return 'accent';
    case 'APPLIED':
      return 'success';
    case 'REJECTED':
      return 'error';
    case 'EXPIRED':
      return 'neutral';
  }
}

// ---------- value prose ----------

/** Variation display name, falling back to a short id so nothing renders blank. */
export function labelVariation(
  variations: readonly Variation[],
  variationId: string | undefined,
): string {
  if (!variationId) return 'nothing';
  const match = variations.find((v) => v.id === variationId);
  if (match) return match.name?.trim() || match.value;
  return `variation ${variationId.slice(0, 8)}`;
}

/**
 * Weight-first serve prose: "50% control / 50% compact", "100% True".
 * Deliberately different from describeServe() in the flags feature — a
 * before → after comparison reads better with both sides in the same unit.
 */
export function describeServeShort(
  serve: RolloutOrVariation | undefined,
  variations: readonly Variation[],
): string {
  if (!serve) return 'not set';
  if (isRollout(serve)) {
    return (serve.rollout ?? [])
      .map((w) => `${w.weight}% ${labelVariation(variations, w.variationId)}`)
      .join(' / ');
  }
  if (serve.variationId) return `100% ${labelVariation(variations, serve.variationId)}`;
  return 'not set';
}

function joinValues(values: readonly string[]): string {
  if (values.length === 0) return '(nothing)';
  if (values.length === 1) return values[0];
  return `${values.slice(0, -1).join(', ')} or ${values[values.length - 1]}`;
}

function attributeLabel(attribute: string): string {
  return attribute === 'key' ? 'context key' : attribute;
}

export function describeClause(clause: Clause): string {
  const attr = attributeLabel(clause.attribute);
  const values = joinValues(clause.values);
  switch (clause.op) {
    case 'EQUALS':
      return clause.values.length > 1 ? `${attr} is one of ${values}` : `${attr} is ${values}`;
    case 'IN':
      return clause.values.length > 1 ? `${attr} is one of ${values}` : `${attr} is ${values}`;
    case 'CONTAINS':
      return `${attr} contains ${values}`;
    case 'STARTS_WITH':
      return `${attr} starts with ${values}`;
    case 'SEGMENT_MATCH':
      return `in segment ${values}`;
    case 'NOT_SEGMENT_MATCH':
      return `not in segment ${values}`;
  }
}

/** "platform is ios and plan is pro → serve 10% True / 90% False". */
export function describeRule(rule: Rule, variations: readonly Variation[]): string {
  const clauses = (rule.clauses ?? []).map(describeClause);
  const when = clauses.length > 0 ? clauses.join(' and ') : 'everyone';
  return `${when} → serve ${describeServeShort(rule.serve, variations)}`;
}

function describeVariations(variations: readonly VariationCreate[]): string {
  return variations
    .map((v) => (v.name?.trim() ? `${v.name.trim()} (${v.value})` : v.value))
    .join(', ');
}

// ---------- per-section summarizing ----------

function targetingLines(
  next: FlagTargetingConfig,
  current: FlagTargetingConfig | undefined,
  variations: readonly Variation[],
): DiffLine[] {
  const lines: DiffLine[] = [];

  const afterFallthrough = describeServeShort(next.fallthrough, variations);
  const beforeFallthrough = current
    ? describeServeShort(current.fallthrough, variations)
    : undefined;
  if (afterFallthrough !== beforeFallthrough) {
    lines.push({
      label: 'Fallthrough',
      before: beforeFallthrough,
      after: afterFallthrough,
      tone: 'changed',
    });
  }

  const nextRules = next.rules ?? [];
  const currentRules = current?.rules ?? [];
  const currentById = new Map(currentRules.map((r) => [r.id, r]));
  const nextIds = new Set(nextRules.map((r) => r.id));

  nextRules.forEach((rule) => {
    const previous = currentById.get(rule.id);
    const after = describeRule(rule, variations);
    if (!previous) {
      lines.push({ label: 'Adds rule', after, tone: 'added' });
      return;
    }
    const before = describeRule(previous, variations);
    if (before !== after) {
      lines.push({ label: 'Changes rule', before, after, tone: 'changed' });
    }
  });

  currentRules
    .filter((rule) => !nextIds.has(rule.id))
    .forEach((rule) => {
      lines.push({ label: 'Removes rule', before: describeRule(rule, variations), tone: 'removed' });
    });

  const nextTargets = next.individualTargets ?? [];
  const currentTargets = current?.individualTargets ?? [];
  if (nextTargets.length !== currentTargets.length) {
    lines.push({
      label: 'Individual targets',
      before: current ? countLabel(currentTargets.length, 'target') : undefined,
      after: countLabel(nextTargets.length, 'target'),
      tone: nextTargets.length > currentTargets.length ? 'added' : 'removed',
    });
  }

  if (current && next.offVariationId !== current.offVariationId) {
    lines.push({
      label: 'Off variation',
      before: labelVariation(variations, current.offVariationId),
      after: labelVariation(variations, next.offVariationId),
      tone: 'changed',
    });
  }
  if (current && next.defaultVariationId !== current.defaultVariationId) {
    lines.push({
      label: 'Default variation',
      before: labelVariation(variations, current.defaultVariationId),
      after: labelVariation(variations, next.defaultVariationId),
      tone: 'changed',
    });
  }

  return lines;
}

function countLabel(count: number, noun: string): string {
  return `${count} ${count === 1 ? noun : `${noun}s`}`;
}

export function summarizeEnvChange(
  change: EnvChange,
  current: FlagEnvConfigResponse | undefined,
  variations: readonly Variation[],
): DiffSection {
  const lines: DiffLine[] = [];

  if (change.enabled !== undefined && change.enabled !== current?.enabled) {
    lines.push({
      label: 'Flag',
      before: current ? (current.enabled ? 'on' : 'off') : undefined,
      after: change.enabled ? 'on' : 'off',
      tone: change.enabled ? 'added' : 'removed',
    });
  }

  if (
    change.killSwitchActive !== undefined &&
    change.killSwitchActive !== current?.killSwitchActive
  ) {
    lines.push({
      label: 'Kill switch',
      before: current ? (current.killSwitchActive ? 'active' : 'off') : undefined,
      after: change.killSwitchActive ? 'active' : 'off',
      tone: change.killSwitchActive ? 'removed' : 'added',
    });
  }

  if (change.config) {
    lines.push(...targetingLines(change.config, current?.config, variations));
  }

  return { title: change.envKey, envKey: change.envKey, lines };
}

// ---------- top level ----------

function headlineFor(diff: FlagChangeDiff): string {
  const envs = (diff.envChanges ?? []).map((c) => c.envKey);
  const where = envs.length === 0 ? '' : ` in ${joinValues(envs)}`;
  switch (diff.kind) {
    case 'FLAG_CREATE':
      return `Create ${diff.flagKey}${where}`;
    case 'FLAG_UPDATE':
      return `Update ${diff.flagKey}${where}`;
    case 'ROLLBACK':
      return diff.rollbackToVersion
        ? `Roll ${diff.flagKey} back to version ${diff.rollbackToVersion}${where}`
        : `Roll ${diff.flagKey} back${where}`;
    case 'RETIREMENT':
      return `Retire ${diff.flagKey}`;
  }
}

export function summarizeDiff(diff: FlagChangeDiff, ctx: DiffContext = {}): DiffSummary {
  const flag = ctx.flag;
  const variations = flag?.variations ?? [];
  const sections: DiffSection[] = [];

  if (diff.kind === 'FLAG_CREATE') {
    const lines: DiffLine[] = [];
    if (diff.name) lines.push({ label: 'Name', after: diff.name, tone: 'added' });
    if (diff.flagKind) {
      lines.push({
        label: 'Type',
        after: diff.flagKind === 'BOOLEAN' ? 'Boolean' : 'String',
        tone: 'added',
      });
    }
    if (diff.description) lines.push({ label: 'Description', after: diff.description, tone: 'added' });
    if (diff.variations && diff.variations.length > 0) {
      lines.push({ label: 'Variations', after: describeVariations(diff.variations), tone: 'added' });
    }
    if (diff.tags && diff.tags.length > 0) {
      lines.push({ label: 'Tags', after: diff.tags.join(', '), tone: 'added' });
    }
    if (lines.length > 0) sections.push({ title: 'New flag', lines });
  } else {
    const lines: DiffLine[] = [];
    if (diff.name && diff.name !== flag?.name) {
      lines.push({ label: 'Name', before: flag?.name, after: diff.name, tone: 'changed' });
    }
    if (diff.description && diff.description !== flag?.description) {
      lines.push({
        label: 'Description',
        before: flag?.description,
        after: diff.description,
        tone: 'changed',
      });
    }
    if (diff.tags && diff.tags.length > 0 && diff.tags.join(',') !== (flag?.tags ?? []).join(',')) {
      lines.push({
        label: 'Tags',
        before: flag ? flag.tags.join(', ') || 'none' : undefined,
        after: diff.tags.join(', '),
        tone: 'changed',
      });
    }
    if (diff.variations && diff.variations.length > 0) {
      lines.push({
        label: 'Adds variations',
        after: describeVariations(diff.variations),
        tone: 'added',
      });
    }
    if (lines.length > 0) sections.push({ title: 'Flag', lines });
  }

  if (diff.kind === 'ROLLBACK' && diff.rollbackToVersion !== undefined) {
    sections.push({
      title: 'Rollback',
      lines: [
        { label: 'Restores', after: `version ${diff.rollbackToVersion}`, tone: 'changed' },
      ],
    });
  }

  (diff.envChanges ?? []).forEach((change) => {
    const current = flag?.envConfigs.find((e) => e.envKey === change.envKey);
    const section = summarizeEnvChange(change, current, variations);
    if (section.lines.length > 0) sections.push(section);
  });

  if (diff.retirementChecklist && diff.retirementChecklist.length > 0) {
    sections.push({
      title: 'Retirement checklist',
      lines: [],
      checklist: [...diff.retirementChecklist],
    });
  }

  return {
    kind: diff.kind,
    kindLabel: proposalKindLabel(diff.kind),
    flagKey: diff.flagKey,
    headline: headlineFor(diff),
    sections,
    hasChanges: sections.length > 0,
  };
}
