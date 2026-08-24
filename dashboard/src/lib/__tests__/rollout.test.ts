import { describe, expect, it } from 'vitest'
import {
  rebalanceWeights,
  sumWeights,
  twoWayRollout,
  validateRolloutWeights,
  validateServe,
} from '@/lib/rollout'
import type { WeightedVariation } from '@/types/api'

const w = (variationId: string, weight: number): WeightedVariation => ({ variationId, weight })

describe('validateRolloutWeights', () => {
  it('accepts weights that sum to exactly 100', () => {
    expect(validateRolloutWeights([w('a', 60), w('b', 20), w('c', 20)])).toBeNull()
  })

  it('accepts a single variation at 100', () => {
    expect(validateRolloutWeights([w('a', 100)])).toBeNull()
  })

  it('tells you how much to remove when over 100', () => {
    expect(validateRolloutWeights([w('a', 60), w('b', 60)])).toBe('Weights total 120% — remove 20%')
  })

  it('tells you how much to add when under 100', () => {
    expect(validateRolloutWeights([w('a', 25), w('b', 25)])).toBe('Weights total 50% — add 50%')
  })

  it('rejects an empty rollout', () => {
    expect(validateRolloutWeights([])).toBe('A rollout needs at least one variation')
  })

  it('rejects fractional weights', () => {
    expect(validateRolloutWeights([w('a', 33.3), w('b', 66.7)])).toBe(
      'Weights must be whole numbers',
    )
  })

  it('rejects out-of-range weights even when the total is right', () => {
    expect(validateRolloutWeights([w('a', 110), w('b', -10)])).toBe(
      'Weights must be between 0 and 100',
    )
  })

  it('allows a zero weight as long as the set still sums to 100', () => {
    expect(validateRolloutWeights([w('a', 100), w('b', 0)])).toBeNull()
  })
})

describe('validateServe', () => {
  it('accepts a single variation', () => {
    expect(validateServe({ variationId: 'a' }, 'Fallthrough')).toBeNull()
  })

  it('accepts a valid rollout', () => {
    expect(validateServe({ rollout: [w('a', 40), w('b', 60)] }, 'Fallthrough')).toBeNull()
  })

  it('rejects setting neither', () => {
    expect(validateServe({}, 'Rule 1')).toBe('Rule 1 must serve a variation or a rollout')
  })

  it('rejects setting both', () => {
    expect(validateServe({ variationId: 'a', rollout: [w('a', 100)] }, 'Rule 1')).toBe(
      'Rule 1 cannot set both a variation and a rollout',
    )
  })

  it('rejects undefined', () => {
    expect(validateServe(undefined, 'Fallthrough')).toBe(
      'Fallthrough must serve a variation or a rollout',
    )
  })

  it('prefixes the weight error with the label', () => {
    expect(validateServe({ rollout: [w('a', 10), w('b', 10)] }, 'Rule 2')).toBe(
      'Rule 2: Weights total 20% — add 80%',
    )
  })
})

describe('rebalanceWeights', () => {
  it('keeps the total at 100 when one weight is edited', () => {
    const next = rebalanceWeights([w('a', 50), w('b', 50)], 0, 25)
    expect(next).toEqual([w('a', 25), w('b', 75)])
    expect(sumWeights(next)).toBe(100)
  })

  it('spreads the remainder proportionally across the others', () => {
    const next = rebalanceWeights([w('a', 20), w('b', 40), w('c', 40)], 0, 40)
    expect(sumWeights(next)).toBe(100)
    expect(next[0].weight).toBe(40)
    expect(next[1].weight).toBe(30)
    expect(next[2].weight).toBe(30)
  })

  it('splits evenly when the other weights are all zero', () => {
    const next = rebalanceWeights([w('a', 100), w('b', 0), w('c', 0)], 0, 40)
    expect(sumWeights(next)).toBe(100)
    expect(next[1].weight).toBe(30)
    expect(next[2].weight).toBe(30)
  })

  it('clamps out-of-range input rather than producing an invalid set', () => {
    expect(rebalanceWeights([w('a', 50), w('b', 50)], 0, 150)).toEqual([w('a', 100), w('b', 0)])
    expect(rebalanceWeights([w('a', 50), w('b', 50)], 0, -20)).toEqual([w('a', 0), w('b', 100)])
  })

  it('rounds fractional input to whole percentages', () => {
    const next = rebalanceWeights([w('a', 50), w('b', 50)], 0, 33.6)
    expect(next).toEqual([w('a', 34), w('b', 66)])
  })

  it('leaves a single-variation rollout at whatever it was given', () => {
    expect(rebalanceWeights([w('a', 100)], 0, 40)).toEqual([w('a', 40)])
  })
})

describe('twoWayRollout', () => {
  it('gives the remainder to the off variation', () => {
    expect(twoWayRollout('on', 'off', 25)).toEqual([w('on', 25), w('off', 75)])
  })

  it('clamps beyond the bounds', () => {
    expect(twoWayRollout('on', 'off', 120)).toEqual([w('on', 100), w('off', 0)])
  })
})
