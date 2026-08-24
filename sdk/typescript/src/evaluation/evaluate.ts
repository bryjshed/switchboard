import type {
  EvalContext,
  EvalOutcome,
  Flag,
  RolloutOrVariation,
  Segment,
  Variation,
} from '../types.js';
import { bucket, WEIGHT_SCALE } from './bucket.js';
import { allClausesMatch } from './clauses.js';
import { validateRollout } from './rolloutWeights.js';

/** Sentinel for a serve the SDK refuses to resolve because the stored config is malformed. */
const UNREADABLE = Symbol('unreadable-config');

const NO_SEGMENTS: ReadonlyMap<string, Segment> = new Map();

/** True when this serve is a rollout: the server sends `rollout: []` alongside a fixed variation. */
export function hasRollout(serve: RolloutOrVariation): boolean {
  return Array.isArray(serve.rollout) && serve.rollout.length > 0;
}

function variationById(flag: Flag, variationId: string | null): Variation | undefined {
  if (variationId === null) {
    return undefined;
  }
  return flag.variations.find((variation) => variation.id === variationId);
}

function outcome(
  flag: Flag,
  variationId: string | null,
  reason: EvalOutcome['reason'],
  ruleId: string | null,
): EvalOutcome {
  const variation = variationById(flag, variationId);
  // A config referencing a deleted variation yields a null value, never an error
  // (spec/evaluation.md 1.3).
  return { variationId, value: variation === undefined ? null : variation.value, reason, ruleId };
}

/**
 * Resolves a serve to a variation id: the fixed variation, or the rollout entry that owns this
 * context's bucket (spec/evaluation.md 5.5).
 *
 * The bucketing salt is always the FLAG key, never the rule id, so moving a context between a rule
 * and the fallthrough never reshuffles it.
 *
 * Returns {@link UNREADABLE} when the rollout's weights violate section 6. Weights are never
 * normalised or repaired at evaluation time.
 */
function resolveServe(
  flagKey: string,
  serve: RolloutOrVariation,
  context: EvalContext,
): string | null | typeof UNREADABLE {
  if (!hasRollout(serve)) {
    return serve.variationId ?? null;
  }
  const rollout = serve.rollout as NonNullable<RolloutOrVariation['rollout']>;
  if (!validateRollout(rollout).valid) {
    return UNREADABLE;
  }
  const contextBucket = bucket(flagKey, context.key);
  let cumulative = 0;
  for (const weighted of rollout) {
    cumulative += weighted.weight * WEIGHT_SCALE;
    if (contextBucket < cumulative) {
      return weighted.variationId;
    }
  }
  // Unreachable once the weights sum to 100: cumulative ends at BUCKET_SPACE and bucket is below it.
  return rollout[rollout.length - 1]!.variationId;
}

/**
 * Serves the caller's own default with reason SDK_DEFAULT (spec/evaluation.md 7).
 *
 * Used for an unknown flag and for a config this SDK cannot read. Never raises.
 */
export function sdkDefault(defaultValue = ''): EvalOutcome {
  return { variationId: null, value: defaultValue, reason: 'SDK_DEFAULT', ruleId: null };
}

/**
 * Evaluates one flag for one context, walking the precedence ladder in spec/evaluation.md 2:
 *
 * 1. kill switch -> off variation, KILL_SWITCH
 * 2. disabled -> off variation, FLAG_OFF
 * 3. individual target on the context key -> that variation, TARGET_MATCH
 * 4. first rule whose clauses ALL match -> resolve its serve, RULE_MATCH (with ruleId)
 * 5. fallthrough rollout -> resolve it, ROLLOUT
 * 6. fixed fallthrough -> that variation, DEFAULT
 *
 * Pure: no clock, no randomness, no I/O, no memoised state. The same inputs always produce the
 * same outcome, in any process and in any language.
 *
 * @param defaultValue served when the config is malformed (fail-safe, spec/evaluation.md 6 and 7).
 */
export function evaluateFlag(
  flag: Flag,
  context: EvalContext,
  segmentsByKey: ReadonlyMap<string, Segment> = NO_SEGMENTS,
  defaultValue = '',
): EvalOutcome {
  const targeting = flag.config;

  if (flag.killSwitchActive) {
    return outcome(flag, targeting.offVariationId, 'KILL_SWITCH', null);
  }
  if (!flag.enabled) {
    return outcome(flag, targeting.offVariationId, 'FLAG_OFF', null);
  }
  for (const target of targeting.individualTargets ?? []) {
    if (target.contextKey === context.key) {
      return outcome(flag, target.variationId, 'TARGET_MATCH', null);
    }
  }
  for (const rule of targeting.rules ?? []) {
    if (allClausesMatch(rule.clauses ?? [], context, segmentsByKey)) {
      const variationId = resolveServe(flag.key, rule.serve, context);
      if (variationId === UNREADABLE) {
        return sdkDefault(defaultValue);
      }
      return outcome(flag, variationId, 'RULE_MATCH', rule.id);
    }
  }
  const fallthrough = targeting.fallthrough;
  if (hasRollout(fallthrough)) {
    const variationId = resolveServe(flag.key, fallthrough, context);
    if (variationId === UNREADABLE) {
      return sdkDefault(defaultValue);
    }
    return outcome(flag, variationId, 'ROLLOUT', null);
  }
  return outcome(flag, fallthrough.variationId ?? null, 'DEFAULT', null);
}

/**
 * Evaluates a flag that may not exist. An unknown flag serves the caller's default with reason
 * SDK_DEFAULT and never raises (spec/evaluation.md 7).
 */
export function evaluate(
  flag: Flag | undefined,
  context: EvalContext,
  segmentsByKey: ReadonlyMap<string, Segment> = NO_SEGMENTS,
  defaultValue = '',
): EvalOutcome {
  if (flag === undefined) {
    return sdkDefault(defaultValue);
  }
  return evaluateFlag(flag, context, segmentsByKey, defaultValue);
}

/** True when a context key is usable for evaluation: present, a string, and not whitespace-only. */
export function isValidContextKey(key: unknown): key is string {
  return typeof key === 'string' && key.trim().length > 0;
}
