import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { FlagEnvStateChip } from '@/components/FlagEnvStateChip'

describe('FlagEnvStateChip', () => {
  it('shows the rollout percentage alongside the environment key', () => {
    render(
      <FlagEnvStateChip
        summary={{ envKey: 'production', enabled: true, killSwitchActive: false, rolloutPercentage: 25 }}
      />,
    )
    const chip = screen.getByTestId('env-state-production')
    expect(chip).toHaveTextContent('production')
    expect(chip).toHaveTextContent('25%')
  })

  it('styles a killed environment destructively rather than in its identity colour', () => {
    render(
      <FlagEnvStateChip summary={{ envKey: 'production', enabled: true, killSwitchActive: true }} />,
    )
    const chip = screen.getByTestId('env-state-production')
    expect(chip).toHaveTextContent('killed')
    expect(chip.className).toContain('text-destructive')
    expect(chip.className).not.toContain('env-production')
  })

  it('uses the neutral palette for an environment key it does not know', () => {
    render(<FlagEnvStateChip summary={{ envKey: 'qa', enabled: false, killSwitchActive: false }} />)
    const chip = screen.getByTestId('env-state-qa')
    expect(chip.className).toContain('env-neutral')
    expect(chip).toHaveTextContent('off')
  })
})
