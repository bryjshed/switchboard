import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import type { AuthUser, DashboardAuthProvider } from '@/auth'
import { useAuth } from '@/hooks/useAuth'

const initAuth = vi.fn<() => Promise<DashboardAuthProvider>>()
const requireAuthProvider = vi.fn<() => Promise<DashboardAuthProvider>>()
const readAuthConfig = vi.fn()
const getMe = vi.fn()

vi.mock('@/auth', () => ({
  initAuth: () => initAuth(),
  requireAuthProvider: () => requireAuthProvider(),
  readAuthConfig: () => readAuthConfig(),
}))
vi.mock('@/lib/orgsApi', () => ({ getMe: () => getMe() }))

const { AuthProvider } = await import('@/context/AuthProvider')

const FIREBASE_CONFIG = {
  kind: 'firebase',
  providerName: 'Firebase',
  firebase: { apiKey: 'k', authDomain: 'd', projectId: 'p', appId: 'a' },
  authEmulatorHost: 'http://localhost:29099',
}

function fakeProvider(user: AuthUser | null) {
  const provider = {
    kind: 'firebase' as const,
    init: vi.fn().mockResolvedValue(undefined),
    signIn: vi.fn().mockResolvedValue(undefined),
    signOut: vi.fn().mockResolvedValue(undefined),
    getIdToken: vi.fn().mockResolvedValue('token'),
    onAuthStateChanged: vi.fn((cb: (u: AuthUser | null) => void) => {
      cb(user)
      return unsubscribe
    }),
  }
  return provider
}

const unsubscribe = vi.fn()

function Probe() {
  const auth = useAuth()
  return (
    <dl>
      <dd data-testid="loading">{String(auth.loading)}</dd>
      <dd data-testid="subject">{auth.user?.subject ?? '-'}</dd>
      <dd data-testid="kind">{auth.providerKind}</dd>
      <dd data-testid="name">{auth.providerName}</dd>
      <dd data-testid="emulator">{String(auth.usingAuthEmulator)}</dd>
      <dd data-testid="profile">{auth.profile?.email ?? '-'}</dd>
      <dd data-testid="profile-error">{auth.profileError ?? '-'}</dd>
      <dd data-testid="auth-error">{auth.authError ?? '-'}</dd>
    </dl>
  )
}

function renderProvider() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  readAuthConfig.mockReturnValue(FIREBASE_CONFIG)
  getMe.mockResolvedValue({ id: 'u1', email: 'alice@switchboard.dev', memberships: [] })
})

afterEach(() => {
  vi.resetModules()
})

describe('AuthProvider', () => {
  it('exposes the neutral AuthUser and loads the Switchboard profile behind it', async () => {
    initAuth.mockResolvedValue(
      fakeProvider({ subject: 'uid-1', email: 'alice@switchboard.dev', displayName: 'Alice' }),
    )
    renderProvider()

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByTestId('subject')).toHaveTextContent('uid-1')
    expect(screen.getByTestId('profile')).toHaveTextContent('alice@switchboard.dev')
    expect(getMe).toHaveBeenCalledTimes(1)
  })

  it('describes the active provider so the login page can adapt', async () => {
    initAuth.mockResolvedValue(fakeProvider(null))
    renderProvider()

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByTestId('kind')).toHaveTextContent('firebase')
    expect(screen.getByTestId('name')).toHaveTextContent('Firebase')
    expect(screen.getByTestId('emulator')).toHaveTextContent('true')
  })

  it('does not call the API when nobody is signed in', async () => {
    initAuth.mockResolvedValue(fakeProvider(null))
    renderProvider()

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByTestId('subject')).toHaveTextContent('-')
    expect(getMe).not.toHaveBeenCalled()
  })

  it('separates a failing profile call from a failing sign-in', async () => {
    initAuth.mockResolvedValue(fakeProvider({ subject: 'uid-1', email: null, displayName: null }))
    getMe.mockRejectedValue(new Error('backend down'))
    renderProvider()

    await waitFor(() => expect(screen.getByTestId('profile-error')).toHaveTextContent('backend down'))
    expect(screen.getByTestId('auth-error')).toHaveTextContent('-')
    expect(screen.getByTestId('subject')).toHaveTextContent('uid-1')
  })

  it('reports a bad configuration instead of trying to sign anyone in', async () => {
    readAuthConfig.mockImplementation(() => {
      throw new Error('VITE_OIDC_CLIENT_ID is required when VITE_AUTH_PROVIDER=oidc.')
    })
    renderProvider()

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    expect(screen.getByTestId('auth-error')).toHaveTextContent('VITE_OIDC_CLIENT_ID')
    expect(initAuth).not.toHaveBeenCalled()
  })

  it('reports a provider that fails to start', async () => {
    initAuth.mockRejectedValue(new Error('Failed to fetch dynamically imported module'))
    renderProvider()

    await waitFor(() => expect(screen.getByTestId('auth-error')).toHaveTextContent('Failed to fetch'))
    expect(screen.getByTestId('loading')).toHaveTextContent('false')
  })

  it('unsubscribes from the provider on unmount', async () => {
    initAuth.mockResolvedValue(fakeProvider(null))
    const { unmount } = renderProvider()

    await waitFor(() => expect(screen.getByTestId('loading')).toHaveTextContent('false'))
    unmount()
    expect(unsubscribe).toHaveBeenCalled()
  })
})
