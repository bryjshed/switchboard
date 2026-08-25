import { readAuthConfig, AuthConfigError, type AuthConfig } from './config'
import type { DashboardAuthProvider } from './types'

export { AuthConfigError, readAuthConfig } from './config'
export type { AuthConfig, FirebaseAuthConfig, OidcAuthConfig } from './config'
export type {
  AuthProviderKind,
  AuthUser,
  DashboardAuthProvider,
  RedirectResult,
  SignInOptions,
} from './types'

/**
 * Provider selection, and the reason it is written this way.
 *
 * The two `import()`s below sit either side of a comparison against
 * `import.meta.env.VITE_AUTH_PROVIDER`, which Vite replaces with a **string literal at build
 * time**. The surviving branch is therefore decided by the bundler, not at runtime: a build with
 * `VITE_AUTH_PROVIDER=oidc` folds the Firebase branch away and never emits the Firebase chunk,
 * and a default build does the same to `oidc-client-ts`. That is the difference between "we
 * don't call Firebase" and "we don't ship Firebase", and only the second one is true here.
 *
 * The unset case must fall to Firebase (a clean checkout runs the local stack with no `.env`),
 * which is why the test is `=== 'oidc'` rather than `=== 'firebase'`.
 */
export async function createAuthProvider(config: AuthConfig): Promise<DashboardAuthProvider> {
  if (import.meta.env.VITE_AUTH_PROVIDER === 'oidc') {
    if (config.kind !== 'oidc') {
      throw new AuthConfigError('This build is OIDC-only but was handed a Firebase config.')
    }
    const { createOidcAuthProvider } = await import('./oidc/oidcAuthProvider')
    return createOidcAuthProvider(config)
  }
  if (config.kind !== 'firebase') {
    throw new AuthConfigError(
      'This build does not include the OIDC provider. Rebuild with VITE_AUTH_PROVIDER=oidc.',
    )
  }
  const { createFirebaseAuthProvider } = await import('./firebase/firebaseAuthProvider')
  return createFirebaseAuthProvider(config)
}

let pending: Promise<DashboardAuthProvider> | null = null
let active: DashboardAuthProvider | null = null

/**
 * Brings up the configured provider exactly once. Rejects with `AuthConfigError` when the env
 * is wrong, which `AuthProvider` renders as a full-screen message — a misconfigured deployment
 * says so on first paint instead of failing at the click of "Sign in".
 */
export function initAuth(): Promise<DashboardAuthProvider> {
  pending ??= (async () => {
    const provider = await createAuthProvider(readAuthConfig())
    await provider.init()
    active = provider
    return provider
  })().catch((err: unknown) => {
    pending = null // a transient failure (SDK chunk 404) should be retryable
    throw err
  })
  return pending
}

/** The live provider, or null before `initAuth()` has resolved. */
export function activeAuthProvider(): DashboardAuthProvider | null {
  return active
}

/** For callers outside React that just need a token — notably `apiClient`. */
export function requireAuthProvider(): Promise<DashboardAuthProvider> {
  return active ? Promise.resolve(active) : initAuth()
}
