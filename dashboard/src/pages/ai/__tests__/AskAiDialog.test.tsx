import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AskAiDialog } from '@/pages/ai/AskAiDialog'
import { ApiClientError } from '@/lib/apiClient'

const draftProposal = vi.fn()
const getFlag = vi.fn()

vi.mock('@/lib/aiApi', () => ({
  draftProposal: (...args: unknown[]) => draftProposal(...args),
  applyProposal: vi.fn(),
  rejectProposal: vi.fn(),
}))

vi.mock('@/lib/flagsApi', () => ({
  getFlag: (...args: unknown[]) => getFlag(...args),
}))

vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspace: () => ({
    environments: [
      { id: 'dev-id', projectId: 'p', key: 'dev', name: 'Development', stateVersion: 1 },
      { id: 'prod-id', projectId: 'p', key: 'production', name: 'Production', stateVersion: 1 },
    ],
    environment: { id: 'dev-id', projectId: 'p', key: 'dev', name: 'Development', stateVersion: 1 },
  }),
}))

function renderDialog() {
  return render(
    <MemoryRouter>
      <AskAiDialog projectId="project-id" open onOpenChange={vi.fn()} />
    </MemoryRouter>,
  )
}

async function submitPrompt(text = 'turn dark-mode fully on in dev') {
  const user = userEvent.setup()
  await user.type(screen.getByTestId('ask-ai-prompt'), text)
  await user.click(screen.getByTestId('ask-ai-submit'))
  return user
}

describe('AskAiDialog', () => {
  beforeEach(() => {
    draftProposal.mockReset()
    getFlag.mockReset()
  })

  it('disables submit until there is a prompt', () => {
    renderDialog()
    expect(screen.getByTestId('ask-ai-submit')).toBeDisabled()
  })

  it('fills the prompt from a tapped example', async () => {
    const user = userEvent.setup()
    renderDialog()
    await user.click(screen.getByTestId('ask-ai-example-1'))
    expect(screen.getByTestId('ask-ai-prompt')).toHaveValue('kill the payments experiment in production')
    expect(screen.getByTestId('ask-ai-submit')).toBeEnabled()
  })

  it('renders 503 AI_UNAVAILABLE as a calm explanation, not an error', async () => {
    draftProposal.mockRejectedValue(
      new ApiClientError('No AI provider configured', 503, 'AI_UNAVAILABLE'),
    )
    renderDialog()
    await submitPrompt()

    const panel = await screen.findByTestId('ask-ai-unavailable')
    expect(panel).toHaveTextContent('AI drafting is not configured')
    // It names the exact thing an operator has to set.
    expect(panel).toHaveTextContent('ANTHROPIC_API_KEY')
    // …and it says the rest of the AI layer is unaffected, which is the whole point.
    expect(panel).toHaveTextContent(/rolling back a variation that starts erroring/i)
    // No red error line, and the form (with its submit button) is gone rather than retryable.
    expect(screen.queryByTestId('ask-ai-error')).not.toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.queryByTestId('ask-ai-submit')).not.toBeInTheDocument()
    expect(screen.getByTestId('ask-ai-close')).toBeInTheDocument()
  })

  it('shows a real failure as an error and leaves submit usable', async () => {
    draftProposal.mockRejectedValue(
      new ApiClientError('Validation failure', 400, 'VALIDATION_FAILED'),
    )
    renderDialog()
    await submitPrompt()

    const error = await screen.findByTestId('ask-ai-error')
    expect(error).toHaveTextContent('Validation failure')
    expect(screen.queryByTestId('ask-ai-unavailable')).not.toBeInTheDocument()
    expect(screen.getByTestId('ask-ai-submit')).toBeEnabled()
  })

  it('shows the drafted diff for review rather than applying anything', async () => {
    draftProposal.mockResolvedValue({
      id: 'proposal-1',
      orgId: 'org',
      projectId: 'project-id',
      kind: 'FLAG_UPDATE',
      status: 'DRAFT',
      createdBy: 'alice@switchboard.dev',
      createdAt: '2026-08-22T00:00:00Z',
      rationale: 'Turns dark-mode fully on in dev.',
      diff: {
        kind: 'FLAG_UPDATE',
        flagKey: 'dark-mode',
        envChanges: [{ envKey: 'dev', enabled: true }],
      },
    })
    getFlag.mockResolvedValue({
      id: 'f',
      projectId: 'project-id',
      key: 'dark-mode',
      name: 'Dark mode',
      kind: 'BOOLEAN',
      variations: [],
      tags: [],
      envConfigs: [],
    })

    renderDialog()
    await submitPrompt()

    await waitFor(() => expect(screen.getByTestId('diff-preview')).toBeInTheDocument())
    expect(screen.getByTestId('diff-env-dev')).toHaveTextContent('on')
    // Applying is a deliberate second step, behind its own confirmation.
    expect(screen.getByTestId('proposal-apply')).toBeInTheDocument()
    expect(screen.getByTestId('proposal-reject')).toHaveTextContent('Discard')
  })
})
