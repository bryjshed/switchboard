import { describe, expect, it } from 'vitest'
import { flagEnvStateLabel } from '@/lib/flagEnvState'
import { latestChange, formatRelative } from '@/lib/format'

describe('flagEnvStateLabel', () => {
  it('reports the rollout percentage when the flag is ramping', () => {
    expect(flagEnvStateLabel({ enabled: true, killSwitchActive: false, rolloutPercentage: 25 })).toBe(
      '25%',
    )
  })

  it('reports "on" for an enabled flag with no rollout', () => {
    expect(flagEnvStateLabel({ enabled: true, killSwitchActive: false })).toBe('on')
  })

  it('reports "off" for a disabled flag', () => {
    expect(flagEnvStateLabel({ enabled: false, killSwitchActive: false })).toBe('off')
  })

  it('lets the kill switch win over enabled, matching evaluation precedence', () => {
    expect(
      flagEnvStateLabel({ enabled: true, killSwitchActive: true, rolloutPercentage: 50 }),
    ).toBe('killed')
  })

  it('shows 0% rather than treating it as absent', () => {
    expect(flagEnvStateLabel({ enabled: true, killSwitchActive: false, rolloutPercentage: 0 })).toBe(
      '0%',
    )
  })
})

describe('latestChange', () => {
  it('picks the most recent updatedAt across environments', () => {
    expect(
      latestChange([
        { updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'alice' },
        { updatedAt: '2026-03-01T00:00:00Z', updatedBy: 'bob' },
        { updatedAt: '2026-02-01T00:00:00Z', updatedBy: 'carol' },
      ]),
    ).toEqual({ updatedAt: '2026-03-01T00:00:00Z', updatedBy: 'bob' })
  })

  it('skips entries with no timestamp', () => {
    expect(latestChange([{ updatedBy: 'alice' }, { updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'bob' }])).toEqual(
      { updatedAt: '2026-01-01T00:00:00Z', updatedBy: 'bob' },
    )
  })

  it('returns empties when nothing has a timestamp', () => {
    expect(latestChange([])).toEqual({ updatedAt: undefined, updatedBy: undefined })
  })
})

describe('formatRelative', () => {
  const now = new Date('2026-03-10T12:00:00Z').getTime()

  it('renders a placeholder for missing or invalid input', () => {
    expect(formatRelative(undefined, now)).toBe('—')
    expect(formatRelative('not a date', now)).toBe('—')
  })

  it('scales from minutes up to years', () => {
    expect(formatRelative('2026-03-10T11:30:00Z', now)).toMatch(/30/)
    expect(formatRelative('2026-03-08T12:00:00Z', now)).toMatch(/2|day/)
    expect(formatRelative('2025-03-10T12:00:00Z', now)).toMatch(/year/)
  })
})
