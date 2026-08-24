import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { WorkspaceContext, type WorkspaceState } from '@/context/workspaceContext'
import type { ChangeRequest } from '@/types/api'

const listChangeRequests = vi.fn()
vi.mock('@/lib/changeRequestsApi', () => ({
  listChangeRequests: (...args: unknown[]) => listChangeRequests(...args),
}))

const { ChangeRequestsPage } = await import('@/pages/changeRequests/ChangeRequestsPage')

const environment = {
  id: 'env-prod',
  projectId: 'project-1',
  key: 'production',
  name: 'Production',
  stateVersion: 1,
}

const workspace = {
  orgs: [],
  org: { id: 'org-1', name: 'Acme', slug: 'acme', role: 'OWNER', createdAt: '2026-01-01T00:00:00Z' },
  projects: [],
  project: { id: 'project-1', orgId: 'org-1', key: 'storefront', name: 'Storefront', environments: [environment] },
  environments: [environment],
  environment,
  loading: false,
  error: null,
  selectOrg: () => {},
  selectProject: () => {},
  selectEnvironment: () => {},
  refresh: async () => {},
} as unknown as WorkspaceState

function makeRequest(patch: Partial<ChangeRequest>): ChangeRequest {
  return {
    id: 'cr-1',
    orgId: 'org-1',
    projectId: 'project-1',
    environmentId: 'env-prod',
    envKey: 'production',
    flagId: 'flag-1',
    flagKey: 'checkout-redesign',
    kind: 'TARGETING_UPDATE',
    payload: { enabled: true },
    baseVersion: 8,
    minApprovals: 2,
    allowSelfApproval: false,
    status: 'PENDING',
    requestedBy: 'alice@switchboard.dev',
    requestedByUserId: 'user-alice',
    createdAt: '2026-08-21T00:00:00Z',
    approvalsMet: 1,
    reviews: [],
    ...patch,
  }
}

function renderPage(initialEntry = '/change-requests') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <WorkspaceContext.Provider value={workspace}>
        <ChangeRequestsPage />
      </WorkspaceContext.Provider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  listChangeRequests.mockReset()
})

describe('ChangeRequestsPage', () => {
  it('renders a row per request with its flag, kind, progress and status', async () => {
    listChangeRequests.mockResolvedValue({ items: [makeRequest({})] })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('cr-list')).toBeInTheDocument())
    const row = screen.getByTestId('cr-row-cr-1')
    expect(row).toHaveTextContent('checkout-redesign')
    expect(row).toHaveTextContent('targeting update')
    expect(row).toHaveTextContent('awaiting review')
    expect(row).toHaveTextContent('1 of 2 approvals')
    expect(row).toHaveTextContent('alice@switchboard.dev')
    expect(row).toHaveAttribute('href', '/change-requests/cr-1')
  })

  // A stale row that looks pending sends a reviewer to a request that cannot be approved.
  it('marks STALE and DECLINED rows differently from PENDING ones', async () => {
    listChangeRequests.mockResolvedValue({
      items: [
        makeRequest({ id: 'cr-pending' }),
        makeRequest({ id: 'cr-stale', status: 'STALE' }),
        makeRequest({ id: 'cr-declined', status: 'DECLINED' }),
      ],
    })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('cr-row-cr-stale')).toBeInTheDocument())
    const pending = screen.getByTestId('cr-row-cr-pending').className
    expect(screen.getByTestId('cr-row-cr-stale').className).not.toBe(pending)
    expect(screen.getByTestId('cr-row-cr-declined').className).not.toBe(pending)
    expect(screen.getByTestId('cr-row-cr-stale')).toHaveTextContent('stale')
  })

  // The filters are in the URL because sending someone this link is the point of the page.
  it('reads its filters from the query string and passes them to the API', async () => {
    listChangeRequests.mockResolvedValue({ items: [] })
    renderPage('/change-requests?status=PENDING&env=production&flag=checkout-redesign')
    await waitFor(() => expect(listChangeRequests).toHaveBeenCalled())
    expect(listChangeRequests).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({
        status: 'PENDING',
        envKey: 'production',
        flagKey: 'checkout-redesign',
      }),
    )
  })

  it('ignores a status the spec does not define rather than sending it upstream', async () => {
    listChangeRequests.mockResolvedValue({ items: [] })
    renderPage('/change-requests?status=NONSENSE')
    await waitFor(() => expect(listChangeRequests).toHaveBeenCalled())
    expect(listChangeRequests).toHaveBeenCalledWith(
      'project-1',
      expect.objectContaining({ status: undefined }),
    )
  })

  it('offers Load more only while the backend hands back a cursor', async () => {
    listChangeRequests.mockResolvedValue({ items: [makeRequest({})], nextCursor: 'cursor-2' })
    renderPage()
    await waitFor(() => expect(screen.getByTestId('cr-load-more')).toBeInTheDocument())
  })

  it('explains where change requests come from when there are none', async () => {
    listChangeRequests.mockResolvedValue({ items: [] })
    renderPage()
    await waitFor(() =>
      expect(screen.getByText(/No change requests/i)).toBeInTheDocument(),
    )
    expect(screen.getByText(/Settings → Approvals/)).toBeInTheDocument()
  })

  it('surfaces a failed load instead of showing an empty queue', async () => {
    listChangeRequests.mockRejectedValue(new Error('backend down'))
    renderPage()
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('backend down'))
  })
})
