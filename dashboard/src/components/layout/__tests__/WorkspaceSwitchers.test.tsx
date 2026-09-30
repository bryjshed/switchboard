import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspaceContext, type WorkspaceState } from '@/context/workspaceContext'
import { PermissionsContext, type PermissionsState } from '@/context/permissionsContext'
import type { Org, Permission, Project, User } from '@/types/api'

const createOrg = vi.fn()
vi.mock('@/lib/orgsApi', () => ({
  createOrg: (...args: unknown[]) => createOrg(...args),
}))

const createProject = vi.fn()
vi.mock('@/lib/projectsApi', () => ({
  createProject: (...args: unknown[]) => createProject(...args),
}))

vi.mock('@/components/ui/use-toast', () => ({
  toast: vi.fn(),
  useToast: () => ({ toast: vi.fn() }),
}))

let profile: User | null = null
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ profile, reloadProfile: vi.fn().mockResolvedValue(undefined) }),
}))

const { WorkspaceSwitchers } = await import('@/components/layout/WorkspaceSwitchers')

const acme = { id: 'org-1', name: 'Acme', slug: 'acme', role: 'OWNER' } as Org
const storefront = {
  id: 'p1',
  orgId: 'org-1',
  key: 'storefront',
  name: 'Storefront',
  environments: [],
} as unknown as Project

function makeProfile(canCreateOrg: boolean): User {
  return {
    id: 'u1',
    email: 'alice@acme.dev',
    onboardingCompleted: true,
    canCreateOrg,
    memberships: [],
  } as User
}

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    orgs: [acme],
    org: acme,
    projects: [storefront],
    project: storefront,
    environments: [],
    environment: null,
    loading: false,
    error: null,
    selectOrg: vi.fn(),
    selectProject: vi.fn(),
    selectEnvironment: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    adopt: vi.fn().mockResolvedValue(undefined),
    needsOrg: false,
    ...overrides,
  }
}

function permissions(granted: Permission[]): PermissionsState {
  const set = new Set<Permission>(granted)
  return {
    permissions: set,
    scopeType: 'ORG',
    scopeId: 'org-1',
    scopeName: 'Acme',
    loading: false,
    error: null,
    has: (...wanted) => wanted.every((p) => set.has(p)),
    hasAny: (...wanted) => wanted.some((p) => set.has(p)),
    refresh: async () => {},
  }
}

function renderSwitchers(value: WorkspaceState, granted: Permission[] = []) {
  return render(
    <WorkspaceContext.Provider value={value}>
      <PermissionsContext.Provider value={permissions(granted)}>
        <WorkspaceSwitchers />
      </PermissionsContext.Provider>
    </WorkspaceContext.Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('WorkspaceSwitchers', () => {
  it('offers "New organization…" when the server says this caller may create one', async () => {
    profile = makeProfile(true)
    const user = userEvent.setup()
    renderSwitchers(workspace())
    await user.click(screen.getByTestId('org-switcher'))
    expect(await screen.findByTestId('org-switcher-new')).toBeInTheDocument()
  })

  it('hides "New organization…" without canCreateOrg', async () => {
    profile = makeProfile(false)
    const user = userEvent.setup()
    renderSwitchers(workspace())
    await user.click(screen.getByTestId('org-switcher'))
    expect(await screen.findByRole('option', { name: 'Acme' })).toBeInTheDocument()
    expect(screen.queryByTestId('org-switcher-new')).not.toBeInTheDocument()
  })

  it('choosing "New organization…" opens the dialog rather than selecting anything', async () => {
    profile = makeProfile(true)
    const value = workspace()
    const user = userEvent.setup()
    renderSwitchers(value)
    await user.click(screen.getByTestId('org-switcher'))
    await user.click(await screen.findByTestId('org-switcher-new'))
    expect(await screen.findByTestId('org-name')).toBeInTheDocument()
    expect(value.selectOrg).not.toHaveBeenCalled()
  })

  it('gates "New project…" on MANAGE_PROJECTS', async () => {
    profile = makeProfile(false)
    const user = userEvent.setup()
    renderSwitchers(workspace(), ['FLAG_READ'])
    await user.click(screen.getByTestId('project-switcher'))
    expect(await screen.findByRole('option', { name: 'Storefront' })).toBeInTheDocument()
    expect(screen.queryByTestId('project-switcher-new')).not.toBeInTheDocument()
  })

  it('keeps the project switcher usable when the org has no projects yet', () => {
    // An org with no projects is exactly when "New project…" is needed; disabling the select
    // there was the dead end.
    profile = makeProfile(false)
    renderSwitchers(workspace({ projects: [], project: null }), ['MANAGE_PROJECTS'])
    expect(screen.getByTestId('project-switcher')).not.toBeDisabled()
  })

  it('creates a project from "New project…", deriving the key from the name, and selects it', async () => {
    profile = makeProfile(false)
    createProject.mockResolvedValue({ ...storefront, id: 'p2', key: 'mobile-app', name: 'Mobile App' })
    const value = workspace({ projects: [], project: null })
    const user = userEvent.setup()
    renderSwitchers(value, ['MANAGE_PROJECTS'])

    await user.click(screen.getByTestId('project-switcher'))
    await user.click(await screen.findByTestId('project-switcher-new'))
    expect(screen.getByText(/Dev, staging and production are created for you/)).toBeInTheDocument()

    await user.type(await screen.findByTestId('project-name'), 'Mobile App')
    expect(screen.getByTestId('project-key')).toHaveValue('mobile-app')
    await user.click(screen.getByTestId('confirm-create-project'))

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith('org-1', { key: 'mobile-app', name: 'Mobile App' }),
    )
    await waitFor(() => expect(value.adopt).toHaveBeenCalledWith('org-1', 'p2'))
  })

  it('refuses an invalid hand-edited key before asking the server', async () => {
    profile = makeProfile(false)
    const user = userEvent.setup()
    renderSwitchers(workspace({ projects: [], project: null }), ['MANAGE_PROJECTS'])

    await user.click(screen.getByTestId('project-switcher'))
    await user.click(await screen.findByTestId('project-switcher-new'))
    await user.type(await screen.findByTestId('project-name'), 'Mobile')
    await user.clear(screen.getByTestId('project-key'))
    await user.type(screen.getByTestId('project-key'), '9Bad')

    expect(screen.getByTestId('project-key-invalid')).toBeInTheDocument()
    expect(screen.getByTestId('confirm-create-project')).toBeDisabled()
  })
})
