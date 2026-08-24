import type { WeightedVariation } from '../types.js';

export type RolloutRejection = 'EMPTY_ROLLOUT' | 'WEIGHT_OUT_OF_RANGE' | 'SUM_NOT_100';

export interface RolloutValidation {
  valid: boolean;
  reason?: RolloutRejection;
}

const VALID: RolloutValidation = { valid: true };

/**
 * Validates rollout weights per spec/evaluation.md section 6.
 *
 * Each weight must be an integer in `[0, 100]` and the weights must sum to exactly 100. A weight of
 * 0 is legal (that variation owns no buckets) but an empty rollout is not.
 *
 * An evaluator MUST NOT normalise, rescale or repair weights. This function exists so a malformed
 * config can be detected and the flag treated as unreadable (fail-safe, section 7) rather than
 * silently moving contexts between variations.
 */
export function validateRolloutWeights(weights: readonly number[]): RolloutValidation {
  if (weights.length === 0) {
    return { valid: false, reason: 'EMPTY_ROLLOUT' };
  }
  let sum = 0;
  for (const weight of weights) {
    if (!Number.isInteger(weight) || weight < 0 || weight > 100) {
      return { valid: false, reason: 'WEIGHT_OUT_OF_RANGE' };
    }
    sum += weight;
  }
  if (sum !== 100) {
    return { valid: false, reason: 'SUM_NOT_100' };
  }
  return VALID;
}

export function validateRollout(rollout: readonly WeightedVariation[]): RolloutValidation {
  return validateRolloutWeights(rollout.map((entry) => entry.weight));
}
