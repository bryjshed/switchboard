import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useWorkspace } from '@/hooks/useWorkspace'

const listOrgs = vi.fn()
vi.mock('@/lib/orgsApi', () => ({ listOrgs: () => listOrgs() }))

const listProjects = vi.fn()
vi.mock('@/lib/projectsApi', () => ({
  listProjects: (...args: unknown[]) => listProjects(...args),
}))

// Stable identity: the provider reloads whenever `profile` changes.
const auth = { profile: { id: 'u1', email: 'dana@newco.dev' } }
vi.mock('@/hooks/useAuth', () => ({ useAuth: () => auth }))

const { WorkspaceProvider } = await import('@/context/WorkspaceProvider')

function Probe() {
  const workspace = useWorkspace()
  return (
    <div>
      <span data-testid="needs-org">{String(workspace.needsOrg)}</span>
      <span data-testid="org">{workspace.org?.id ?? ''}</span>
      <span data-testid="project">{workspace.project?.id ?? ''}</span>
      <span data-testid="error">{workspace.error ?? ''}</span>
      <button onClick={() => void workspace.adopt('o2', 'p2')}>adopt</button>
    </div>
  )
}

function renderProvider() {
  return render(
    <WorkspaceProvider>
      <Probe />
    </WorkspaceProvider>,
  )
}

const org = (id: string) => ({ id, name: id, slug: id, role: 'OWNER', createdAt: '' })
const project = (id: string) => ({ id, orgId: 'o', key: id, name: id, environments: [] })

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
})

describe('WorkspaceProvider', () => {
  it('reports needsOrg once a successful load finds no orgs', async () => {
    listOrgs.mockResolvedValue([])
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('needs-org')).toHaveTextContent('true'))
  })

  it('does not report needsOrg when loading failed — that is an error, not an empty account', async () => {
    listOrgs.mockRejectedValue(new Error('boom'))
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('error')).toHaveTextContent('boom'))
    expect(screen.getByTestId('needs-org')).toHaveTextContent('false')
  })

  it('adopt lands on the named org and project rather than the first', async () => {
    listOrgs.mockResolvedValue([org('o1')])
    listProjects.mockResolvedValue([])
    renderProvider()
    await waitFor(() => expect(screen.getByTestId('org')).toHaveTextContent('o1'))

    listOrgs.mockResolvedValue([org('o1'), org('o2')])
    listProjects.mockResolvedValue([project('p1'), project('p2')])
    await userEvent.setup().click(screen.getByRole('button', { name: 'adopt' }))

    await waitFor(() => expect(screen.getByTestId('project')).toHaveTextContent('p2'))
    expect(screen.getByTestId('org')).toHaveTextContent('o2')
    expect(screen.getByTestId('project')).toHaveTextContent('p2')
    expect(listProjects).toHaveBeenLastCalledWith('o2')
    expect(screen.getByTestId('needs-org')).toHaveTextContent('false')
  })
})
