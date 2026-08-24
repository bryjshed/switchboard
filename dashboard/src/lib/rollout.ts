import type { RolloutOrVariation, WeightedVariation } from '@/types/api'

export const ROLLOUT_TOTAL = 100

export function sumWeights(weights: readonly WeightedVariation[]): number {
  return weights.reduce((total, w) => total + (Number.isFinite(w.weight) ? w.weight : 0), 0)
}

/**
 * Validates one rollout weight set against the backend's contract: weights are integers in
 * [0, 100] and must sum to exactly 100. Returns null when valid, else a message for the
 * inline validator that blocks save.
 */
export function validateRolloutWeights(weights: readonly WeightedVariation[]): string | null {
  if (weights.length === 0) return 'A rollout needs at least one variation'
  for (const w of weights) {
    if (!Number.isInteger(w.weight)) return 'Weights must be whole numbers'
    if (w.weight < 0 || w.weight > ROLLOUT_TOTAL) return 'Weights must be between 0 and 100'
  }
  const total = sumWeights(weights)
  if (total !== ROLLOUT_TOTAL) {
    const delta = total - ROLLOUT_TOTAL
    return delta > 0
      ? `Weights total ${total}% — remove ${delta}%`
      : `Weights total ${total}% — add ${-delta}%`
  }
  return null
}

/**
 * The spec says exactly one of variationId / rollout must be set on a RolloutOrVariation.
 * Returns null when valid, else a message.
 */
export function validateServe(serve: RolloutOrVariation | undefined, label: string): string | null {
  if (!serve) return `${label} must serve a variation or a rollout`
  const hasVariation = Boolean(serve.variationId)
  const hasRollout = Array.isArray(serve.rollout) && serve.rollout.length > 0
  if (hasVariation && hasRollout) return `${label} cannot set both a variation and a rollout`
  if (!hasVariation && !hasRollout) return `${label} must serve a variation or a rollout`
  if (hasRollout) {
    const err = validateRolloutWeights(serve.rollout!)
    if (err) return `${label}: ${err}`
  }
  return null
}

/**
 * Rebalances so the edited index keeps its new weight and the remainder is spread over the
 * others, leaving the set summing to 100 without the user doing the arithmetic. Any
 * rounding drift lands on the last non-edited entry.
 */
export function rebalanceWeights(
  weights: readonly WeightedVariation[],
  changedIndex: number,
  newWeight: number,
): WeightedVariation[] {
  const clamped = Math.max(0, Math.min(ROLLOUT_TOTAL, Math.round(newWeight)))
  const next = weights.map((w, i) => ({ ...w, weight: i === changedIndex ? clamped : w.weight }))
  const others = next.filter((_, i) => i !== changedIndex)
  if (others.length === 0) return next

  const remaining = ROLLOUT_TOTAL - clamped
  const othersTotal = sumWeights(others)
  let assigned = 0
  others.forEach((w, i) => {
    const share =
      othersTotal === 0
        ? Math.floor(remaining / others.length)
        : Math.floor((w.weight / othersTotal) * remaining)
    w.weight = share
    assigned += share
    if (i === others.length - 1) w.weight += remaining - assigned
  })
  return next
}

/**
 * A two-way "percent on" rollout over exactly two variations — the shape behind the
 * percentage slider. `onVariationId` gets `percent`, the other gets the remainder.
 */
export function twoWayRollout(
  onVariationId: string,
  offVariationId: string,
  percent: number,
): WeightedVariation[] {
  const on = Math.max(0, Math.min(ROLLOUT_TOTAL, Math.round(percent)))
  return [
    { variationId: onVariationId, weight: on },
    { variationId: offVariationId, weight: ROLLOUT_TOTAL - on },
  ]
}
