import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { Environment } from '@/types/api'

const createEnvironment = vi.fn()
const updateEnvironment = vi.fn()
vi.mock('@/lib/projectsApi', () => ({
  createEnvironment: (...args: unknown[]) => createEnvironment(...args),
  updateEnvironment: (...args: unknown[]) => updateEnvironment(...args),
}))

const { EnvironmentsTab } = await import('@/pages/settings/EnvironmentsTab')

const environments: Environment[] = [
  { id: 'e1', projectId: 'p1', key: 'dev', name: 'Development', stateVersion: 3 },
  { id: 'e2', projectId: 'p1', key: 'production', name: 'Production', stateVersion: 9 },
] as Environment[]

const withArchived: Environment[] = [
  ...environments,
  {
    id: 'e3',
    projectId: 'p1',
    key: 'staging-eu',
    name: 'Staging (EU)',
    stateVersion: 1,
    archivedAt: '2026-08-26T10:00:00Z',
  },
] as Environment[]

function renderTab(overrides: Partial<Parameters<typeof EnvironmentsTab>[0]> = {}) {
  const onChanged = vi.fn().mockResolvedValue(undefined)
  render(
    <EnvironmentsTab
      projectId="p1"
      projectName="Storefront"
      environments={environments}
      canManage
      onChanged={onChanged}
      {...overrides}
    />,
  )
  return { onChanged }
}

beforeEach(() => {
  vi.clearAllMocks()
  createEnvironment.mockResolvedValue({ id: 'e3', projectId: 'p1', key: 'staging-eu' })
  updateEnvironment.mockResolvedValue({ id: 'e1', projectId: 'p1', key: 'dev' })
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
    const { onChanged } = renderTab()

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
    await waitFor(() => expect(onChanged).toHaveBeenCalled())
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

  it('points at restore when the key is held by an ARCHIVED environment', async () => {
    // The key stays reserved by an archived environment, so "already exists" would send
    // someone looking for a row that is not in the list above.
    const user = userEvent.setup()
    renderTab({ environments: withArchived })
    await user.click(screen.getByTestId('create-environment'))
    await user.type(screen.getByTestId('env-key'), 'staging-eu')

    expect(screen.getByTestId('env-key-archived')).toBeInTheDocument()
    expect(screen.queryByTestId('env-key-duplicate')).not.toBeInTheDocument()
  })

  it('renames the display name and leaves the key alone', async () => {
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByTestId('rename-dev'))
    const input = screen.getByTestId('env-rename')
    await user.clear(input)
    await user.type(input, 'Dev (shared)')
    await user.click(screen.getByTestId('confirm-rename'))

    await waitFor(() =>
      expect(updateEnvironment).toHaveBeenCalledWith('e1', { name: 'Dev (shared)' }),
    )
    // No key in the payload at all: it is what SDK keys and the audit trail refer to.
    expect(updateEnvironment.mock.calls[0][1]).not.toHaveProperty('key')
  })

  it('warns that an archived environment KEEPS SERVING before archiving it', async () => {
    // The dangerous misreading is "archive == turn it off". It does not: SDK keys pointed at
    // it keep evaluating, so somebody archiving a live environment to take it down would be
    // wrong in the worst possible direction.
    const user = userEvent.setup()
    renderTab()
    await user.click(screen.getByTestId('archive-dev'))
    expect(screen.getByTestId('archive-still-serves-warning')).toBeInTheDocument()

    await user.click(screen.getByTestId('confirm-archive'))
    await waitFor(() => expect(updateEnvironment).toHaveBeenCalledWith('e1', { archived: true }))
  })

  it('will not archive the last active environment', () => {
    // A project with an empty environment picker has no way back through the UI. The server
    // refuses this too - this only saves the round trip.
    renderTab({ environments: [environments[0]] })
    expect(screen.getByTestId('archive-dev')).toBeDisabled()
  })

  it('lists archived environments separately and restores them', async () => {
    const user = userEvent.setup()
    renderTab({ environments: withArchived })

    expect(screen.getByTestId('archived-environments')).toBeInTheDocument()
    // Archived ones are NOT in the main table.
    expect(screen.queryByTestId('environment-staging-eu')).not.toBeInTheDocument()

    await user.click(screen.getByTestId('restore-staging-eu'))
    await waitFor(() => expect(updateEnvironment).toHaveBeenCalledWith('e3', { archived: false }))
  })

  it('shows the list but disables every change without permission', () => {
    // Same pattern as the other admin tabs: explain rather than vanish. The backend refuses
    // regardless, so this is guidance and not a security boundary.
    renderTab({ canManage: false })
    expect(screen.getByTestId('environment-dev')).toBeInTheDocument()
    expect(screen.getByTestId('create-environment')).toBeDisabled()
    expect(screen.getByTestId('rename-dev')).toBeDisabled()
    expect(screen.getByTestId('archive-dev')).toBeDisabled()
    expect(screen.getByTestId('environments-readonly')).toBeInTheDocument()
  })
})
