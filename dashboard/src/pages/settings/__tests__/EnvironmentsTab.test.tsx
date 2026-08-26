import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Environment } from '@/types/api'

const createEnvironment = vi.fn()
vi.mock('@/lib/projectsApi', () => ({
  createEnvironment: (...args: unknown[]) => createEnvironment(...args),
}))

const { EnvironmentsTab } = await import('@/pages/settings/EnvironmentsTab')

const environments: Environment[] = [
  { id: 'e1', projectId: 'p1', key: 'dev', name: 'Development', stateVersion: 3 },
  { id: 'e2', projectId: 'p1', key: 'production', name: 'Production', stateVersion: 9 },
] as Environment[]

function renderTab(overrides: Partial<Parameters<typeof EnvironmentsTab>[0]> = {}) {
  const onCreated = vi.fn().mockResolvedValue(undefined)
  render(
    <EnvironmentsTab
      projectId="p1"
      projectName="Storefront"
      environments={environments}
      canManage
      onCreated={onCreated}
      {...overrides}
    />,
  )
  return { onCreated }
}

beforeEach(() => {
  vi.clearAllMocks()
  createEnvironment.mockResolvedValue({ id: 'e3', projectId: 'p1', key: 'staging-eu' })
})

describe('EnvironmentsTab', () => {
  it('lists the environments the project already has', () => {
    renderTab()
    expect(screen.getByTestId('environment-dev')).toBeInTheDocument()
    expect(screen.getByTestId('environment-production')).toBeInTheDocument()
  })

  it('creates one and reloads the workspace', async () => {
    // The reload is the part worth asserting: the environment picker and every
    // per-environment screen read from the workspace, so a new environment is invisible
    // until it re-reads.
    const user = userEvent.setup()
    const { onCreated } = renderTab()

    await user.click(screen.getByTestId('create-environment'))
    await user.type(screen.getByTestId('env-key'), 'staging-eu')
    await user.type(screen.getByTestId('env-name'), 'Staging (EU)')
    await user.click(screen.getByTestId('confirm-create-environment'))

    await waitFor(() =>
      expect(createEnvironment).toHaveBeenCalledWith('p1', {
        key: 'staging-eu',
        name: 'Staging (EU)',
      }),
    )
    await waitFor(() => expect(onCreated).toHaveBeenCalled())
  })

  it('falls back to the key when no name is given', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByTestId('create-environment'))
    await user.type(screen.getByTestId('env-key'), 'qa')
    await user.click(screen.getByTestId('confirm-create-environment'))

    await waitFor(() =>
      expect(createEnvironment).toHaveBeenCalledWith('p1', { key: 'qa', name: 'qa' }),
    )
  })

  it('refuses a key the server would reject, before sending it', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByTestId('create-environment'))
    await user.type(screen.getByTestId('env-key'), 'Staging EU')

    expect(screen.getByTestId('env-key-invalid')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-create-environment')).toBeDisabled()
    expect(createEnvironment).not.toHaveBeenCalled()
  })

  it('refuses a duplicate key, which the server answers with a 409', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByTestId('create-environment'))
    await user.type(screen.getByTestId('env-key'), 'production')

    expect(screen.getByTestId('env-key-duplicate')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-create-environment')).toBeDisabled()
  })

  it('warns that creation is irreversible, because it currently is', async () => {
    // There is no rename, archive or delete yet, so an environment created by mistake appears
    // in every picker forever. Saying so beforehand is cheaper than the alternative.
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByTestId('create-environment'))
    expect(screen.getByTestId('env-permanence-warning')).toBeInTheDocument()
  })

  it('shows the list but disables creation without permission', () => {
    // Same pattern as the other admin tabs: explain rather than vanish. The backend refuses
    // regardless, so this is guidance and not a security boundary.
    renderTab({ canManage: false })
    expect(screen.getByTestId('environment-dev')).toBeInTheDocument()
    expect(screen.getByTestId('create-environment')).toBeDisabled()
    expect(screen.getByTestId('environments-readonly')).toBeInTheDocument()
  })
})
