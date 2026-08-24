import { describe, expect, it } from 'vitest'
import { compareEnvKeys, envChipClasses, envColorKey, sortEnvKeys } from '@/lib/envColors'

describe('envColorKey', () => {
  it('maps the three canonical environments', () => {
    expect(envColorKey('dev')).toBe('dev')
    expect(envColorKey('staging')).toBe('staging')
    expect(envColorKey('production')).toBe('production')
  })

  it('accepts common aliases', () => {
    expect(envColorKey('development')).toBe('dev')
    expect(envColorKey('stage')).toBe('staging')
    expect(envColorKey('prod')).toBe('production')
  })

  it('is case-insensitive', () => {
    expect(envColorKey('Production')).toBe('production')
  })

  it('falls back to neutral for a custom environment', () => {
    expect(envColorKey('qa')).toBe('neutral')
    expect(envColorKey('eu-west-canary')).toBe('neutral')
    expect(envColorKey('')).toBe('neutral')
  })
})

describe('envChipClasses', () => {
  it('gives each known environment a distinct class set', () => {
    const classes = ['dev', 'staging', 'production'].map(envChipClasses)
    expect(new Set(classes).size).toBe(3)
  })

  it('never reuses the state palette (ok / destructive) for environment identity', () => {
    for (const key of ['dev', 'staging', 'production', 'qa']) {
      expect(envChipClasses(key)).not.toMatch(/\bbg-ok|\bbg-destructive|text-destructive/)
    }
  })

  it('returns the neutral classes for an unknown key', () => {
    expect(envChipClasses('qa')).toBe(envChipClasses('anything-else'))
  })
})

describe('compareEnvKeys', () => {
  it('orders dev before staging before production', () => {
    expect(['production', 'dev', 'staging'].sort(compareEnvKeys)).toEqual([
      'dev',
      'staging',
      'production',
    ])
  })

  it('sorts unknown environments after the known three', () => {
    expect(['qa', 'production', 'dev'].sort(compareEnvKeys)).toEqual(['dev', 'production', 'qa'])
  })

  it('breaks ties between unknown environments alphabetically', () => {
    expect(['zeta', 'alpha'].sort(compareEnvKeys)).toEqual(['alpha', 'zeta'])
  })
})

describe('sortEnvKeys', () => {
  it('sorts objects by their env key without mutating the input', () => {
    const input = [{ key: 'production' }, { key: 'dev' }, { key: 'staging' }]
    const sorted = sortEnvKeys(input, (e) => e.key)
    expect(sorted.map((e) => e.key)).toEqual(['dev', 'staging', 'production'])
    expect(input.map((e) => e.key)).toEqual(['production', 'dev', 'staging'])
  })
})
