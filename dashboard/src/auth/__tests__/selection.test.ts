import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AuthConfig } from '@/auth/config'

/**
 * These tests are about *loading*, not behaviour: the promise the dashboard makes is that an
 * OIDC deployment never touches Firebase. Both implementation modules are replaced with
 * factories that record the moment they are evaluated, so "was it imported" becomes an
 * assertion rather than an inspection of the bundle.
 */
const loaded: string[] = []

function stubProviderModules() {
  vi.doMock('@/auth/firebase/firebaseAuthProvider', () => {
    loaded.push('firebase')
    return { createFirebaseAuthProvider: () => ({ kind: 'firebase' }) }
  })
  vi.doMock('@/auth/oidc/oidcAuthProvider', () => {
    loaded.push('oidc')
    return { createOidcAuthProvider: () => ({ kind: 'oidc' }) }
  })
}

const FIREBASE_CONFIG = {
  kind: 'firebase',
  providerName: 'Firebase',
  firebase: { apiKey: 'k', authDomain: 'd', projectId: 'p', appId: 'a' },
  authEmulatorHost: null,
} satisfies AuthConfig

const OIDC_CONFIG = {
  kind: 'oidc',
  providerName: 'acme.okta.com',
  authority: 'https://acme.okta.com/oauth2/default',
  clientId: '0oa1b2c3',
  scope: 'openid profile email',
  audience: null,
  redirectUri: 'https://app/auth/callback',
  silentRedirectUri: 'https://app/auth/silent-callback',
  postLogoutRedirectUri: 'https://app/login',
} satisfies AuthConfig

beforeEach(() => {
  loaded.length = 0
  vi.resetModules()
  stubProviderModules()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.doUnmock('@/auth/firebase/firebaseAuthProvider')
  vi.doUnmock('@/auth/oidc/oidcAuthProvider')
})

describe('createAuthProvider', () => {
  it('loads only the OIDC implementation when the build selects oidc', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'oidc')
    const { createAuthProvider } = await import('@/auth')

    const provider = await createAuthProvider(OIDC_CONFIG)

    expect(provider.kind).toBe('oidc')
    expect(loaded).toEqual(['oidc'])
    expect(loaded).not.toContain('firebase')
  })

  it('loads only the Firebase implementation when the build selects firebase', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'firebase')
    const { createAuthProvider } = await import('@/auth')

    const provider = await createAuthProvider(FIREBASE_CONFIG)

    expect(provider.kind).toBe('firebase')
    expect(loaded).toEqual(['firebase'])
    expect(loaded).not.toContain('oidc')
  })

  it('falls to Firebase when nothing is configured, so a clean checkout still works', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', '')
    const { createAuthProvider } = await import('@/auth')

    expect((await createAuthProvider(FIREBASE_CONFIG)).kind).toBe('firebase')
    expect(loaded).toEqual(['firebase'])
  })

  it('refuses an OIDC config in a Firebase build rather than silently signing in wrong', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'firebase')
    const { createAuthProvider, AuthConfigError } = await import('@/auth')

    await expect(createAuthProvider(OIDC_CONFIG)).rejects.toBeInstanceOf(AuthConfigError)
    expect(loaded).toEqual([])
  })

  it('refuses a Firebase config in an OIDC build', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'oidc')
    const { createAuthProvider, AuthConfigError } = await import('@/auth')

    await expect(createAuthProvider(FIREBASE_CONFIG)).rejects.toBeInstanceOf(AuthConfigError)
    expect(loaded).toEqual([])
  })
})

describe('initAuth', () => {
  it('reads the environment, builds the provider once, and caches it', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'oidc')
    vi.stubEnv('VITE_OIDC_AUTHORITY', 'https://acme.okta.com/oauth2/default')
    vi.stubEnv('VITE_OIDC_CLIENT_ID', '0oa1b2c3')
    vi.doMock('@/auth/oidc/oidcAuthProvider', () => {
      loaded.push('oidc')
      return { createOidcAuthProvider: () => ({ kind: 'oidc', init: () => Promise.resolve() }) }
    })
    const { initAuth, activeAuthProvider, requireAuthProvider } = await import('@/auth')

    expect(activeAuthProvider()).toBeNull()
    const first = await initAuth()
    const second = await requireAuthProvider()

    expect(first).toBe(second)
    expect(activeAuthProvider()).toBe(first)
    expect(loaded).toEqual(['oidc'])
  })

  it('surfaces a configuration fault instead of resolving to a broken provider', async () => {
    vi.stubEnv('VITE_AUTH_PROVIDER', 'oidc')
    vi.stubEnv('VITE_OIDC_AUTHORITY', '')
    const { initAuth, AuthConfigError, activeAuthProvider } = await import('@/auth')

    await expect(initAuth()).rejects.toBeInstanceOf(AuthConfigError)
    expect(activeAuthProvider()).toBeNull()
  })
})
