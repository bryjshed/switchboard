import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { PermissionsContext, type PermissionsState } from '@/context/permissionsContext'
import type { Org, OrgInvitation, OrgMember, Permission } from '@/types/api'

const listOrgMembers = vi.fn()
const removeOrgMember = vi.fn()
const listInvitations = vi.fn()
const createInvitation = vi.fn()
const revokeInvitation = vi.fn()
vi.mock('@/lib/orgsApi', () => ({
  listOrgMembers: (...args: unknown[]) => listOrgMembers(...args),
  removeOrgMember: (...args: unknown[]) => removeOrgMember(...args),
  listInvitations: (...args: unknown[]) => listInvitations(...args),
  createInvitation: (...args: unknown[]) => createInvitation(...args),
  revokeInvitation: (...args: unknown[]) => revokeInvitation(...args),
}))

const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  toast: (...args: unknown[]) => toast(...args),
  useToast: () => ({ toast }),
}))

vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ profile: { id: 'u-alice', email: 'alice@acme.dev' } }),
}))

const { OrganizationTab } = await import('@/pages/settings/OrganizationTab')

const org = {
  id: 'org-1',
  name: 'Acme',
  slug: 'acme',
  role: 'OWNER',
  createdAt: '2026-08-01T10:00:00Z',
} as Org

const alice = {
  userId: 'u-alice',
  email: 'alice@acme.dev',
  role: 'OWNER',
  joinedAt: '2026-08-01T10:00:00Z',
} as OrgMember

function invitation(patch: Partial<OrgInvitation> = {}): OrgInvitation {
  return {
    id: 'inv-1',
    email: 'dana@acme.dev',
    role: 'MEMBER',
    status: 'PENDING',
    invitedBy: 'alice@acme.dev',
    createdAt: '2026-09-01T10:00:00Z',
    ...patch,
  } as OrgInvitation
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

function renderTab(granted: Permission[] = ['MANAGE_MEMBERS']) {
  return render(
    <PermissionsContext.Provider value={permissions(granted)}>
      <OrganizationTab org={org} />
    </PermissionsContext.Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  listOrgMembers.mockResolvedValue([alice])
  listInvitations.mockResolvedValue([])
})

async function invite(email: string) {
  const user = userEvent.setup()
  await user.type(screen.getByTestId('member-email'), email)
  await user.click(screen.getByTestId('member-invite'))
  return user
}

describe('OrganizationTab invitations', () => {
  it('invites someone new: PENDING, says they join on first sign-in, and lists them', async () => {
    createInvitation.mockResolvedValue(invitation())
    renderTab()
    expect(await screen.findByTestId('invitations-empty')).toBeInTheDocument()

    listInvitations.mockResolvedValue([invitation()])
    await invite('dana@acme.dev')

    await waitFor(() =>
      expect(createInvitation).toHaveBeenCalledWith('org-1', {
        email: 'dana@acme.dev',
        role: 'MEMBER',
      }),
    )
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Invited dana@acme.dev',
        description: expect.stringMatching(/first time they sign in/),
      }),
    )
    expect(await screen.findByTestId('invitation-row-dana@acme.dev')).toBeInTheDocument()
  })

  it('invites someone who already has an account: ACCEPTED, says they are a member now', async () => {
    createInvitation.mockResolvedValue(
      invitation({ email: 'bob@acme.dev', status: 'ACCEPTED', acceptedAt: '2026-09-01T10:00:00Z' }),
    )
    renderTab()
    await screen.findByTestId('invitations-empty')

    listOrgMembers.mockResolvedValue([
      alice,
      { userId: 'u-bob', email: 'bob@acme.dev', role: 'MEMBER', joinedAt: '2026-09-01T10:00:00Z' },
    ])
    await invite('bob@acme.dev')

    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'Added bob@acme.dev',
        description: expect.stringMatching(/member of Acme now/),
      }),
    )
    // The members list is re-read, so the new member shows without a reload.
    expect(await screen.findByTestId('member-row-bob@acme.dev')).toBeInTheDocument()
    expect(screen.queryByTestId('invitation-row-bob@acme.dev')).not.toBeInTheDocument()
  })

  it('shows a duplicate-invitation conflict inline', async () => {
    createInvitation.mockRejectedValue(new Error('A pending invitation for that email already exists'))
    renderTab()
    await screen.findByTestId('invitations-empty')
    await invite('dana@acme.dev')
    expect(await screen.findByTestId('member-invite-error')).toHaveTextContent(/already exists/)
  })

  it('revokes a pending invitation after confirming', async () => {
    listInvitations.mockResolvedValue([invitation()])
    revokeInvitation.mockResolvedValue(undefined)
    const user = userEvent.setup()
    renderTab()

    const row = await screen.findByTestId('invitation-row-dana@acme.dev')
    expect(within(row).getByText('MEMBER')).toBeInTheDocument()
    await user.click(screen.getByTestId('invitation-revoke-dana@acme.dev'))
    // Nothing happens until the confirmation.
    expect(revokeInvitation).not.toHaveBeenCalled()

    listInvitations.mockResolvedValue([])
    await user.click(await screen.findByTestId('invitation-revoke-confirm'))

    await waitFor(() => expect(revokeInvitation).toHaveBeenCalledWith('org-1', 'inv-1'))
    expect(await screen.findByTestId('invitations-empty')).toBeInTheDocument()
    expect(toast).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Revoked the invitation for dana@acme.dev' }),
    )
  })

  it('copies the sign-in link', async () => {
    const user = userEvent.setup()
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    renderTab()
    await screen.findByTestId('invitations-empty')
    await user.click(screen.getByTestId('copy-sign-in-link'))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/login`))
  })

  it('without MANAGE_MEMBERS neither invites nor asks for the invitation list', async () => {
    renderTab(['FLAG_READ'])
    await screen.findByTestId('member-row-alice@acme.dev')
    expect(screen.queryByTestId('member-invite')).not.toBeInTheDocument()
    expect(screen.queryByText('Pending invitations')).not.toBeInTheDocument()
    expect(listInvitations).not.toHaveBeenCalled()
  })
})
