import { describe, expect, it } from 'vitest'
import { KEY_PATTERN, slugify, validateKey } from '@/lib/flagKey'

describe('slugify', () => {
  it('lowercases and hyphenates a human name', () => {
    expect(slugify('New Checkout')).toBe('new-checkout')
  })

  it('collapses runs of punctuation into one hyphen', () => {
    expect(slugify('Pro   plan // features!!')).toBe('pro-plan-features')
  })

  it('drops leading characters that are not letters', () => {
    expect(slugify('2024 rollout')).toBe('rollout')
    expect(slugify('--dark mode')).toBe('dark-mode')
  })

  it('trims a trailing hyphen', () => {
    expect(slugify('checkout ')).toBe('checkout')
    expect(slugify('checkout!')).toBe('checkout')
  })

  it('keeps digits after the first letter', () => {
    expect(slugify('Planner v2')).toBe('planner-v2')
  })

  it('returns an empty string when nothing usable is left', () => {
    expect(slugify('123')).toBe('')
    expect(slugify('   ')).toBe('')
  })

  it('never produces something validateKey would reject', () => {
    const inputs = ['New Checkout', 'Pro plan / features', 'Planner v2', '2024 Ramp', 'a']
    for (const input of inputs) {
      const slug = slugify(input)
      if (slug) expect(validateKey(slug)).toBeNull()
    }
  })

  it('truncates to the max length without leaving a trailing hyphen', () => {
    const slug = slugify('aaaa bbbb cccc', 10)
    expect(slug.length).toBeLessThanOrEqual(10)
    expect(slug.endsWith('-')).toBe(false)
    expect(KEY_PATTERN.test(slug)).toBe(true)
  })
})

describe('validateKey', () => {
  it('accepts a well-formed key', () => {
    expect(validateKey('new-checkout')).toBeNull()
    expect(validateKey('a')).toBeNull()
    expect(validateKey('planner-v2')).toBeNull()
  })

  it('requires a value', () => {
    expect(validateKey('', 'Flag key')).toBe('Flag key is required')
  })

  it('rejects uppercase, underscores and spaces', () => {
    expect(validateKey('New-Checkout')).toMatch(/lowercase/)
    expect(validateKey('new_checkout')).toMatch(/lowercase/)
    expect(validateKey('new checkout')).toMatch(/lowercase/)
  })

  it('rejects a leading digit or hyphen', () => {
    expect(validateKey('2fast')).toMatch(/lowercase/)
    expect(validateKey('-nope')).toMatch(/lowercase/)
  })

  it('rejects an over-long key', () => {
    expect(validateKey('a'.repeat(129))).toMatch(/128 characters or fewer/)
  })

  it('uses the supplied noun in the message', () => {
    expect(validateKey('Bad', 'Segment key')).toMatch(/^Segment key/)
  })
})
