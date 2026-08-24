import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { AnomalyList } from '@/pages/monitor/AnomalyList'
import type { AnomalyFinding, AnomalyStatus } from '@/types/api'

function finding(id: string, status: AnomalyStatus, extra: Partial<AnomalyFinding> = {}): AnomalyFinding {
  return {
    id,
    environmentId: 'prod-id',
    flagKey: 'new-checkout',
    metricKey: 'error',
    baselineRate: 0.08,
    variantRate: 0.226667,
    zScore: 3.4265,
    status,
    createdAt: '2026-08-22T23:12:47Z',
    summary: 'Variation True recorded a 22.7% error rate against 8.0% for False.',
    ...extra,
  }
}

function renderList(findings: AnomalyFinding[], onAck = vi.fn()) {
  render(
    <MemoryRouter>
      <AnomalyList
        findings={findings}
        onAck={onAck}
        ackingId={null}
        flagLinkFor={(key) => `/flags/${key}`}
      />
    </MemoryRouter>,
  )
  return onAck
}

describe('AnomalyList', () => {
  it('shows the baseline, the variant rate and the z-score', () => {
    renderList([finding('a', 'OPEN')])
    const row = screen.getByTestId('anomaly-a')
    expect(row).toHaveTextContent('8.0%')
    expect(row).toHaveTextContent('22.7%')
    expect(row).toHaveTextContent('3.43')
    expect(row).toHaveTextContent('Variation True recorded')
  })

  it('offers Acknowledge only on an open finding', () => {
    const onAck = renderList([finding('a', 'OPEN')])
    screen.getByTestId('anomaly-ack-a').click()
    expect(onAck).toHaveBeenCalledOnce()
  })

  it('says the system already acted on an auto-rolled-back finding, with nothing to acknowledge', () => {
    renderList([finding('b', 'AUTO_ROLLED_BACK')])
    const row = screen.getByTestId('anomaly-b')
    expect(row).toHaveTextContent(/Switchboard already rolled this rollout back/i)
    expect(screen.getByTestId('anomaly-status-b')).toHaveTextContent('rolled back automatically')
    expect(screen.queryByTestId('anomaly-ack-b')).not.toBeInTheDocument()
  })

  it('marks an acknowledged finding without offering to acknowledge it again', () => {
    renderList([finding('c', 'ACKED')])
    expect(screen.getByTestId('anomaly-status-c')).toHaveTextContent('acknowledged')
    expect(screen.queryByTestId('anomaly-ack-c')).not.toBeInTheDocument()
  })

  it('links to the suggested proposal only when one is attached', () => {
    renderList([finding('d', 'OPEN', { suggestedProposalId: 'p-1' }), finding('e', 'OPEN')])
    expect(screen.getByTestId('anomaly-proposal-d')).toHaveAttribute('href', '/ai/proposals/p-1')
    expect(screen.queryByTestId('anomaly-proposal-e')).not.toBeInTheDocument()
  })

  it('always offers a way into the flag itself', () => {
    renderList([finding('f', 'OPEN')])
    expect(screen.getByTestId('anomaly-flag-f')).toHaveAttribute('href', '/flags/new-checkout')
  })
})
