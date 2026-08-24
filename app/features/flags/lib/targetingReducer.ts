import { uuidv4 } from '@shared/lib/id';
import type {
  Clause,
  FlagTargetingConfig,
  IndividualTarget,
  RolloutOrVariation,
  Rule,
} from '@shared/api/types';

import { isValidServe } from './targeting';

export interface TargetingDraft {
  enabled: boolean;
  config: FlagTargetingConfig;
}

export type TargetingAction =
  | { type: 'reset'; draft: TargetingDraft }
  | { type: 'setEnabled'; enabled: boolean }
  | { type: 'addTarget' }
  | { type: 'updateTarget'; index: number; patch: Partial<IndividualTarget> }
  | { type: 'removeTarget'; index: number }
  | { type: 'addRule' }
  | { type: 'removeRule'; ruleId: string }
  | { type: 'updateRule'; ruleId: string; patch: Partial<Omit<Rule, 'id'>> }
  | { type: 'addClause'; ruleId: string }
  | { type: 'updateClause'; ruleId: string; index: number; patch: Partial<Clause> }
  | { type: 'removeClause'; ruleId: string; index: number }
  | { type: 'setFallthrough'; serve: RolloutOrVariation }
  | { type: 'setOffVariation'; variationId: string }
  | { type: 'setDefaultVariation'; variationId: string };

const NEW_CLAUSE: Clause = { attribute: '', op: 'EQUALS', values: [] };

function mapRules(
  config: FlagTargetingConfig,
  ruleId: string,
  fn: (rule: Rule) => Rule,
): FlagTargetingConfig {
  return { ...config, rules: (config.rules ?? []).map((r) => (r.id === ruleId ? fn(r) : r)) };
}

/**
 * Pure targeting-draft reducer. Every branch returns a fresh config so the
 * dirty check can stay a structural comparison against the loaded version.
 */
export function targetingReducer(state: TargetingDraft, action: TargetingAction): TargetingDraft {
  const { config } = state;
  switch (action.type) {
    case 'reset':
      return action.draft;

    case 'setEnabled':
      return { ...state, enabled: action.enabled };

    case 'addTarget':
      return {
        ...state,
        config: {
          ...config,
          individualTargets: [
            ...(config.individualTargets ?? []),
            { contextKey: '', variationId: config.defaultVariationId },
          ],
        },
      };

    case 'updateTarget':
      return {
        ...state,
        config: {
          ...config,
          individualTargets: (config.individualTargets ?? []).map((t, i) =>
            i === action.index ? { ...t, ...action.patch } : t,
          ),
        },
      };

    case 'removeTarget':
      return {
        ...state,
        config: {
          ...config,
          individualTargets: (config.individualTargets ?? []).filter((_, i) => i !== action.index),
        },
      };

    case 'addRule':
      return {
        ...state,
        config: {
          ...config,
          rules: [
            ...(config.rules ?? []),
            {
              id: uuidv4(),
              clauses: [{ ...NEW_CLAUSE }],
              serve: { variationId: config.defaultVariationId },
            },
          ],
        },
      };

    case 'removeRule':
      return {
        ...state,
        config: { ...config, rules: (config.rules ?? []).filter((r) => r.id !== action.ruleId) },
      };

    case 'updateRule':
      return { ...state, config: mapRules(config, action.ruleId, (r) => ({ ...r, ...action.patch })) };

    case 'addClause':
      return {
        ...state,
        config: mapRules(config, action.ruleId, (r) => ({
          ...r,
          clauses: [...r.clauses, { ...NEW_CLAUSE }],
        })),
      };

    case 'updateClause':
      return {
        ...state,
        config: mapRules(config, action.ruleId, (r) => ({
          ...r,
          clauses: r.clauses.map((c, i) => (i === action.index ? { ...c, ...action.patch } : c)),
        })),
      };

    case 'removeClause':
      return {
        ...state,
        config: mapRules(config, action.ruleId, (r) => ({
          ...r,
          clauses: r.clauses.filter((_, i) => i !== action.index),
        })),
      };

    case 'setFallthrough':
      return { ...state, config: { ...config, fallthrough: action.serve } };

    case 'setOffVariation':
      return { ...state, config: { ...config, offVariationId: action.variationId } };

    case 'setDefaultVariation':
      return { ...state, config: { ...config, defaultVariationId: action.variationId } };

    default:
      return state;
  }
}

/** First reason the draft cannot be saved, or null when it is writable. */
export function targetingError(draft: TargetingDraft): string | null {
  const { config } = draft;
  if (!config.offVariationId) return 'Pick an off variation';
  if (!config.defaultVariationId) return 'Pick a default variation';

  const targets = config.individualTargets ?? [];
  if (targets.some((t) => !t.contextKey.trim())) return 'Every target needs a context key';
  if (targets.some((t) => !t.variationId)) return 'Every target needs a variation';

  for (const rule of config.rules ?? []) {
    if (rule.clauses.length === 0) return 'Every rule needs at least one clause';
    if (rule.clauses.some((c) => !c.attribute.trim())) return 'Every clause needs an attribute';
    if (rule.clauses.some((c) => c.values.length === 0)) return 'Every clause needs a value';
    if (!isValidServe(rule.serve)) return 'Rule rollout weights must total 100';
  }

  if (!isValidServe(config.fallthrough)) return 'Fallthrough rollout weights must total 100';
  return null;
}

/** Structural equality against the loaded config — drives the Save button's dirty gate. */
export function isDirty(draft: TargetingDraft, original: TargetingDraft): boolean {
  return JSON.stringify(normalize(draft)) !== JSON.stringify(normalize(original));
}

/** Normalizes optional-vs-empty differences the backend round-trips (rules: []
 * vs undefined, rollout: [] alongside a fixed variationId). */
function normalize(draft: TargetingDraft): unknown {
  const { config } = draft;
  const serve = (s: RolloutOrVariation) =>
    s.rollout && s.rollout.length > 0
      ? { rollout: s.rollout.map((w) => ({ variationId: w.variationId, weight: w.weight })) }
      : { variationId: s.variationId };
  return {
    enabled: draft.enabled,
    offVariationId: config.offVariationId,
    defaultVariationId: config.defaultVariationId,
    individualTargets: (config.individualTargets ?? []).map((t) => ({
      contextKey: t.contextKey,
      variationId: t.variationId,
    })),
    rules: (config.rules ?? []).map((r) => ({
      id: r.id,
      description: r.description ?? '',
      clauses: r.clauses.map((c) => ({ attribute: c.attribute, op: c.op, values: c.values })),
      serve: serve(r.serve),
    })),
    fallthrough: serve(config.fallthrough),
  };
}
