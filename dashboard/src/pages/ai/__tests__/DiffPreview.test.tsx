import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { DiffPreview } from '@/pages/ai/DiffPreview'
import type { FlagChangeDiff, FlagDetail } from '@/types/api'

const CONTROL = '2769171a-3dd5-48b2-b1c3-f0cbc95f3237'
const COMPACT = 'b78b7b07-8eed-4b49-8861-af7104bb06aa'

const flag: FlagDetail = {
  id: 'flag-id',
  projectId: 'project-id',
  key: 'planner-v2',
  name: 'Planner v2',
  kind: 'STRING',
  variations: [
    { id: CONTROL, value: 'control', name: 'Control' },
    { id: COMPACT, value: 'compact', name: 'Compact' },
  ],
  tags: [],
  envConfigs: [
    {
      flagId: 'flag-id',
      environmentId: 'prod-id',
      envKey: 'production',
      enabled: true,
      killSwitchActive: false,
      config: {
        individualTargets: [],
        rules: [],
        fallthrough: { rollout: [{ variationId: CONTROL, weight: 100 }] },
        offVariationId: CONTROL,
        defaultVariationId: CONTROL,
      },
      version: 4,
      updatedAt: '2026-08-20T00:00:00Z',
      updatedBy: 'alice@switchboard.dev',
    },
  ],
}

const rampDiff: FlagChangeDiff = {
  kind: 'FLAG_UPDATE',
  flagKey: 'planner-v2',
  envChanges: [
    {
      envKey: 'production',
      config: {
        individualTargets: [],
        rules: [],
        fallthrough: {
          rollout: [
            { variationId: CONTROL, weight: 50 },
            { variationId: COMPACT, weight: 50 },
          ],
        },
        offVariationId: CONTROL,
        defaultVariationId: CONTROL,
      },
    },
  ],
}

describe('DiffPreview', () => {
  it('reads the change in prose, never as raw JSON', () => {
    render(<DiffPreview diff={rampDiff} flag={flag} />)
    const section = screen.getByTestId('diff-env-production')
    expect(section).toHaveTextContent('100% Control (control)')
    expect(section).toHaveTextContent('50% Control (control) / 50% Compact (compact)')
    expect(section.textContent).not.toContain('{')
    expect(section.textContent).not.toContain('variationId')
  })

  it('warns that before values are missing when the flag cannot be read', () => {
    render(<DiffPreview diff={rampDiff} flag={null} />)
    expect(screen.getByTestId('diff-preview')).toHaveTextContent(
      /current values unavailable/i,
    )
  })

  it('does not claim missing before values for a flag it is creating', () => {
    render(
      <DiffPreview
        diff={{ kind: 'FLAG_CREATE', flagKey: 'brand-new', flagKind: 'BOOLEAN' }}
        flag={null}
      />,
    )
    expect(screen.getByTestId('diff-preview')).not.toHaveTextContent(/current values unavailable/i)
  })

  it('renders a retirement checklist as a checklist', () => {
    render(
      <DiffPreview
        diff={{
          kind: 'RETIREMENT',
          flagKey: 'legacy-search',
          retirementChecklist: ['Remove every reference', 'Delete the flag'],
        }}
        flag={null}
      />,
    )
    const checklist = screen.getByTestId('diff-checklist')
    expect(checklist.querySelectorAll('li')).toHaveLength(2)
    expect(checklist).toHaveTextContent('Remove every reference')
  })

  it('says plainly when a proposal would change nothing', () => {
    render(
      <DiffPreview
        diff={{ kind: 'FLAG_UPDATE', flagKey: 'planner-v2', envChanges: [] }}
        flag={flag}
      />,
    )
    expect(screen.getByTestId('diff-empty')).toBeInTheDocument()
  })

  it('shows a skeleton rather than a wrong diff while the flag is loading', () => {
    render(<DiffPreview diff={rampDiff} flag={null} flagLoading />)
    expect(screen.getByTestId('diff-preview-loading')).toBeInTheDocument()
    expect(screen.queryByTestId('diff-preview')).not.toBeInTheDocument()
  })
})
