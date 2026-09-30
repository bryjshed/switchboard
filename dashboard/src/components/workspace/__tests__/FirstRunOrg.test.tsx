import { beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { WorkspaceContext, type WorkspaceState } from '@/context/workspaceContext'
import type { User } from '@/types/api'

const createOrg = vi.fn()
vi.mock('@/lib/orgsApi', () => ({
  createOrg: (...args: unknown[]) => createOrg(...args),
}))

const toast = vi.fn()
vi.mock('@/components/ui/use-toast', () => ({
  toast: (...args: unknown[]) => toast(...args),
  useToast: () => ({ toast }),
}))

const reloadProfile = vi.fn()
const sendEmailVerification = vi.fn()
const refreshToken = vi.fn()
let profile: User | null = null
// What the auth seam reports. Defaults to a provider that says nothing about verification.
let authExtras: {
  emailVerified: boolean | null
  sendEmailVerification?: () => Promise<void>
  refreshToken?: () => Promise<void>
} = { emailVerified: null }
vi.mock('@/hooks/useAuth', () => ({
  useAuth: () => ({ profile, reloadProfile, ...authExtras }),
}))

const { FirstRunOrg } = await import('@/components/workspace/FirstRunOrg')

function makeProfile(canCreateOrg: boolean): User {
  return {
    id: 'u1',
    email: 'dana@newco.dev',
    onboardingCompleted: false,
    canCreateOrg,
    memberships: [],
  } as User
}

function workspace(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    orgs: [],
    org: null,
    projects: [],
    project: null,
    environments: [],
    environment: null,
    loading: false,
    error: null,
    selectOrg: vi.fn(),
    selectProject: vi.fn(),
    selectEnvironment: vi.fn(),
    refresh: vi.fn().mockResolvedValue(undefined),
    adopt: vi.fn().mockResolvedValue(undefined),
    needsOrg: true,
    ...overrides,
  }
}

function renderFirstRun(value: WorkspaceState) {
  return render(
    <WorkspaceContext.Provider value={value}>
      <FirstRunOrg />
    </WorkspaceContext.Provider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  reloadProfile.mockResolvedValue(undefined)
  sendEmailVerification.mockResolvedValue(undefined)
  refreshToken.mockResolvedValue(undefined)
  authExtras = { emailVerified: null }
})

/** A Firebase-like provider reporting the address unverified. */
function unverifiedFirebase() {
  authExtras = {
    emailVerified: false,
    sendEmailVerification: () => sendEmailVerification(),
    refreshToken: () => refreshToken(),
  }
}

describe('FirstRunOrg', () => {
  it('offers to create an org when the server allows it, and mentions the invitation route', () => {
    profile = makeProfile(true)
    renderFirstRun(workspace())
    expect(screen.getByText('Create your organization')).toBeInTheDocument()
    expect(screen.getByTestId('first-run-create-org')).toBeInTheDocument()
    // The address is spelled out because it must match exactly what the admin types.
    expect(screen.getByTestId('first-run-join-hint')).toHaveTextContent('dana@newco.dev')
  })

  it('creates the org, selects it, and re-reads the profile', async () => {
    // Re-reading the profile matters under `bootstrap`: canCreateOrg flips to false once the
    // first org exists, and the "New organization…" entry must go with it.
    profile = makeProfile(true)
    createOrg.mockResolvedValue({ id: 'org-new', name: 'NewCo', slug: 'newco', role: 'OWNER' })
    const value = workspace()
    const user = userEvent.setup()
    renderFirstRun(value)

    await user.click(screen.getByTestId('first-run-create-org'))
    await user.type(await screen.findByTestId('org-name'), '  NewCo ')
    await user.click(screen.getByTestId('confirm-create-org'))

    await waitFor(() => expect(createOrg).toHaveBeenCalledWith({ name: 'NewCo' }))
    await waitFor(() => expect(value.adopt).toHaveBeenCalledWith('org-new'))
    expect(reloadProfile).toHaveBeenCalled()
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ title: 'Created NewCo' }))
  })

  it('shows the server refusal inline and keeps the dialog open', async () => {
    profile = makeProfile(true)
    createOrg.mockRejectedValue(new Error('Organization creation is disabled on this instance'))
    const value = workspace()
    const user = userEvent.setup()
    renderFirstRun(value)

    await user.click(screen.getByTestId('first-run-create-org'))
    await user.type(await screen.findByTestId('org-name'), 'NewCo')
    await user.click(screen.getByTestId('confirm-create-org'))

    expect(await screen.findByTestId('create-org-error')).toHaveTextContent(/disabled/)
    expect(value.adopt).not.toHaveBeenCalled()
    expect(screen.getByTestId('org-name')).toBeInTheDocument()
  })

  it('without canCreateOrg shows only the invitation message, naming the email', () => {
    profile = makeProfile(false)
    renderFirstRun(workspace())
    expect(screen.getByText('You need an invitation')).toBeInTheDocument()
    expect(screen.getByTestId('first-run-invite-only')).toHaveTextContent('dana@newco.dev')
    expect(screen.queryByTestId('first-run-create-org')).not.toBeInTheDocument()
    expect(screen.queryByText('Create your organization')).not.toBeInTheDocument()
  })

  it('reload re-reads the workspace and the profile', async () => {
    profile = makeProfile(false)
    const value = workspace()
    const user = userEvent.setup()
    renderFirstRun(value)

    await user.click(screen.getByTestId('first-run-reload'))
    await waitFor(() => expect(value.refresh).toHaveBeenCalled())
    expect(reloadProfile).toHaveBeenCalled()
  })

  describe('email verification', () => {
    it('says nothing about verification when the provider does not report unverified', () => {
      profile = makeProfile(false)
      authExtras = { emailVerified: true, sendEmailVerification, refreshToken }
      renderFirstRun(workspace())
      expect(screen.queryByTestId('first-run-verify')).not.toBeInTheDocument()
      expect(screen.getByTestId('first-run-reload')).toHaveTextContent('Reload')
    })

    it('offers to send a verification email when unverified, in both branches', () => {
      unverifiedFirebase()
      for (const canCreate of [true, false]) {
        profile = makeProfile(canCreate)
        const { unmount } = renderFirstRun(workspace())
        expect(screen.getByTestId('first-run-verify')).toHaveTextContent(
          /Verify your email to join organizations you’ve been invited to/,
        )
        expect(screen.getByTestId('first-run-send-verification')).toBeInTheDocument()
        // The existing branches stay.
        if (canCreate) expect(screen.getByTestId('first-run-create-org')).toBeInTheDocument()
        else expect(screen.getByTestId('first-run-invite-only')).toBeInTheDocument()
        unmount()
      }
    })

    it('sends the verification email and says so', async () => {
      unverifiedFirebase()
      profile = makeProfile(false)
      const user = userEvent.setup()
      renderFirstRun(workspace())
      await user.click(screen.getByTestId('first-run-send-verification'))
      await waitFor(() => expect(sendEmailVerification).toHaveBeenCalled())
      expect(toast).toHaveBeenCalledWith(
        expect.objectContaining({ title: 'Verification email sent' }),
      )
    })

    it('reports a failure to send as a destructive toast', async () => {
      unverifiedFirebase()
      sendEmailVerification.mockRejectedValue(new Error('auth/too-many-requests'))
      profile = makeProfile(false)
      const user = userEvent.setup()
      renderFirstRun(workspace())
      await user.click(screen.getByTestId('first-run-send-verification'))
      await waitFor(() =>
        expect(toast).toHaveBeenCalledWith(
          expect.objectContaining({
            variant: 'destructive',
            description: 'auth/too-many-requests',
          }),
        ),
      )
    })

    it('"check again" refreshes the token, then /users/me, then the workspace — in that order', async () => {
      // The fresh token carries email_verified; /users/me is where the backend accepts the
      // invitation; only then does the org list contain the org.
      unverifiedFirebase()
      profile = makeProfile(false)
      const value = workspace()
      const user = userEvent.setup()
      renderFirstRun(value)

      const button = screen.getByTestId('first-run-reload')
      expect(button).toHaveTextContent('I’ve verified — check again')
      await user.click(button)

      await waitFor(() => expect(value.refresh).toHaveBeenCalled())
      const refreshOrder = refreshToken.mock.invocationCallOrder[0]
      const profileOrder = reloadProfile.mock.invocationCallOrder[0]
      const workspaceOrder = (value.refresh as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0]
      expect(refreshOrder).toBeLessThan(profileOrder)
      expect(profileOrder).toBeLessThan(workspaceOrder)
    })

    it('without provider support (OIDC) explains, and hides the controls', () => {
      authExtras = { emailVerified: false }
      profile = makeProfile(false)
      renderFirstRun(workspace())
      expect(screen.getByTestId('first-run-verify')).toHaveTextContent(/identity provider/)
      expect(screen.queryByTestId('first-run-send-verification')).not.toBeInTheDocument()
      expect(screen.getByTestId('first-run-reload')).toHaveTextContent('Reload')
    })
  })
})
