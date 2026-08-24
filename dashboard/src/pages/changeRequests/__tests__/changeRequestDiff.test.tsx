import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { DiffPreview } from '@/pages/ai/DiffPreview'
import { QueuedForReviewNotice } from '@/components/QueuedForReviewNotice'
import { ApprovalProgress, ChangeRequestStatusBadge } from '@/pages/changeRequests/changeRequestBadges'
import { changeRequestToDiff } from '@/lib/changeRequestDisplay'
import type { ChangeRequest, FlagDetail } from '@/types/api'

const CONTROL = '2769171a-3dd5-48b2-b1c3-f0cbc95f3237'
const VARIANT = 'b78b7b07-8eed-4b49-8861-af7104bb06aa'

const flag: FlagDetail = {
  id: 'flag-1',
  projectId: 'project-1',
  key: 'checkout-redesign',
  name: 'Checkout redesign',
  kind: 'STRING',
  variations: [
    { id: CONTROL, value: 'control', name: 'Control' },
    { id: VARIANT, value: 'variant', name: 'Variant' },
  ],
  tags: [],
  envConfigs: [
    {
      flagId: 'flag-1',
      environmentId: 'env-prod',
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
      version: 8,
      updatedAt: '2026-08-20T00:00:00Z',
      updatedBy: 'alice@switchboard.dev',
    },
  ],
}

const queuedRamp: ChangeRequest = {
  id: 'cr-1',
  orgId: 'org-1',
  projectId: 'project-1',
  environmentId: 'env-prod',
  envKey: 'production',
  flagId: 'flag-1',
  flagKey: 'checkout-redesign',
  kind: 'TARGETING_UPDATE',
  payload: {
    enabled: true,
    config: {
      individualTargets: [],
      rules: [],
      fallthrough: {
        rollout: [
          { variationId: CONTROL, weight: 50 },
          { variationId: VARIANT, weight: 50 },
        ],
      },
      offVariationId: CONTROL,
      defaultVariationId: CONTROL,
    },
  },
  baseVersion: 8,
  minApprovals: 2,
  allowSelfApproval: false,
  status: 'PENDING',
  requestedBy: 'alice@switchboard.dev',
  requestedByUserId: 'user-alice',
  comment: 'Ramp to half',
  createdAt: '2026-08-21T00:00:00Z',
  approvalsMet: 1,
  reviews: [],
}

describe('rendering a queued targeting change as a diff', () => {
  // The reviewer must read prose, not JSON: this is the trust surface an approval rests on.
  it('shows the ramp as before → after against the flag’s live config', () => {
    render(<DiffPreview diff={changeRequestToDiff(queuedRamp)} flag={flag} />)
    const line = screen.getByTestId('diff-line-fallthrough')
    expect(line).toHaveTextContent('100% Control (control)')
    expect(line).toHaveTextContent('50% Control (control) / 50% Variant (variant)')
  })

  it('renders inside the production environment section', () => {
    render(<DiffPreview diff={changeRequestToDiff(queuedRamp)} flag={flag} />)
    expect(screen.getByTestId('diff-env-production')).toBeInTheDocument()
  })

  it('degrades to the proposed state alone when the flag could not be read', () => {
    render(<DiffPreview diff={changeRequestToDiff(queuedRamp)} flag={null} />)
    expect(screen.getByTestId('diff-preview')).toHaveTextContent(/current values unavailable/i)
  })

  it('renders a queued kill switch as a kill line, not a flag toggle', () => {
    const killed: ChangeRequest = {
      ...queuedRamp,
      kind: 'KILL_SWITCH',
      payload: { active: true },
    }
    render(<DiffPreview diff={changeRequestToDiff(killed)} flag={flag} />)
    const line = screen.getByTestId('diff-line-kill')
    expect(line).toHaveTextContent(/kill switch/i)
    expect(line).toHaveTextContent('clear')
    expect(line).toHaveTextContent('active')
  })

  it('takes a custom heading so a change request is not mislabelled as a proposal', () => {
    render(
      <DiffPreview
        diff={changeRequestToDiff(queuedRamp)}
        flag={flag}
        heading={<span data-testid="cr-heading">targeting update</span>}
      />,
    )
    expect(screen.getByTestId('cr-heading')).toBeInTheDocument()
    expect(screen.queryByText('Update flag')).not.toBeInTheDocument()
  })
})

describe('QueuedForReviewNotice', () => {
  // A person walking away believing they changed a flag they did not is the worst outcome
  // this whole feature can produce, so the notice has to say "unchanged" outright.
  it('says the flag is unchanged and links to the request', () => {
    render(
      <MemoryRouter>
        <QueuedForReviewNotice changeRequest={queuedRamp} />
      </MemoryRouter>,
    )
    const notice = screen.getByTestId('queued-for-review')
    expect(notice).toHaveTextContent(/unchanged in production/i)
    expect(notice).toHaveTextContent(/1 of 2 approvals/)
    expect(screen.getByTestId('queued-for-review-link')).toHaveAttribute(
      'href',
      '/change-requests/cr-1',
    )
  })
})

describe('change request badges', () => {
  it('labels each status in words rather than the raw enum', () => {
    render(<ChangeRequestStatusBadge status="PENDING" />)
    expect(screen.getByTestId('cr-status-PENDING')).toHaveTextContent('awaiting review')
  })

  it('marks a stale request distinctly from a pending one', () => {
    const { rerender } = render(<ChangeRequestStatusBadge status="STALE" />)
    const stale = screen.getByTestId('cr-status-STALE').className
    rerender(<ChangeRequestStatusBadge status="PENDING" />)
    expect(screen.getByTestId('cr-status-PENDING').className).not.toBe(stale)
  })

  it('shows approval progress as a fraction of the threshold', () => {
    render(<ApprovalProgress changeRequest={queuedRamp} />)
    expect(screen.getByTestId('cr-approval-progress')).toHaveTextContent('1 of 2 approvals')
  })
})
