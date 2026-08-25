import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { AuthContext, type AuthState } from '@/context/authContext'

const { LoginPage } = await import('@/pages/LoginPage')

const signIn = vi.fn()

function renderLogin(overrides: Partial<AuthState> = {}) {
  const value = {
    user: null,
    providerKind: 'firebase',
    providerName: 'Firebase',
    usingAuthEmulator: true,
    profile: null,
    loading: false,
    profileError: null,
    authError: null,
    signIn,
    reloadProfile: async () => {},
    signOut: async () => {},
    ...overrides,
  } as AuthState

  return render(
    <MemoryRouter initialEntries={['/login']}>
      <AuthContext.Provider value={value}>
        <LoginPage />
      </AuthContext.Provider>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  signIn.mockReset()
  signIn.mockResolvedValue(undefined)
})

describe('LoginPage on the Firebase provider', () => {
  it('keeps the email and password form', async () => {
    renderLogin()

    await userEvent.type(screen.getByTestId('login-email'), 'alice@switchboard.dev')
    await userEvent.type(screen.getByTestId('login-password'), 'password123')
    await userEvent.click(screen.getByTestId('login-submit'))

    expect(signIn).toHaveBeenCalledWith({
      email: 'alice@switchboard.dev',
      password: 'password123',
    })
  })

  it('shows the seeded logins only against the emulator', () => {
    renderLogin()
    expect(screen.getByText(/alice@switchboard.dev/)).toBeInTheDocument()

    renderLogin({ usingAuthEmulator: false })
    expect(screen.queryAllByText(/bob@switchboard.dev/)).toHaveLength(1)
  })

  it('renders a mapped sentence rather than the raw SDK error', async () => {
    signIn.mockRejectedValue({ code: 'auth/invalid-credential' })
    renderLogin()

    await userEvent.type(screen.getByTestId('login-email'), 'alice@switchboard.dev')
    await userEvent.type(screen.getByTestId('login-password'), 'wrong')
    await userEvent.click(screen.getByTestId('login-submit'))

    await waitFor(() =>
      expect(screen.getByTestId('login-error')).toHaveTextContent(
        'That email and password do not match an account.',
      ),
    )
  })
})

describe('LoginPage on the OIDC provider', () => {
  const oidc = { providerKind: 'oidc' as const, providerName: 'acme.okta.com', usingAuthEmulator: false }

  it('offers a redirect button and no credential fields', async () => {
    renderLogin(oidc)

    expect(screen.queryByTestId('login-email')).not.toBeInTheDocument()
    expect(screen.queryByTestId('login-password')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: /Sign in with acme.okta.com/ }))
    expect(signIn).toHaveBeenCalledWith({ returnTo: '/flags' })
  })

  it('maps an OIDC failure to a sentence', async () => {
    signIn.mockRejectedValue({ error: 'access_denied' })
    renderLogin(oidc)

    await userEvent.click(screen.getByTestId('login-oidc'))

    await waitFor(() =>
      expect(screen.getByTestId('login-error')).toHaveTextContent(/cancelled/),
    )
  })
})

describe('LoginPage when auth is misconfigured', () => {
  it('says so instead of showing a form that cannot work', () => {
    renderLogin({ authError: 'VITE_OIDC_CLIENT_ID is required when VITE_AUTH_PROVIDER=oidc.' })

    expect(screen.getByTestId('login-config-error')).toHaveTextContent('VITE_OIDC_CLIENT_ID')
    expect(screen.queryByTestId('login-submit')).not.toBeInTheDocument()
    expect(screen.queryByTestId('login-oidc')).not.toBeInTheDocument()
  })
})
