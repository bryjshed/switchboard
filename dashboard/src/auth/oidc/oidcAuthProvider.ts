import { UserManager, type User } from 'oidc-client-ts'
import type { OidcAuthConfig } from '../config'
import { oidcSettings, tokenFor } from './settings'
import { oidcToAuthUser } from './mapUser'
import type {
  AuthUser,
  DashboardAuthProvider,
  RedirectResult,
  SignInOptions,
} from '../types'

/**
 * The generic OIDC implementation: authorization code flow with PKCE, which is the only
 * correct choice for a browser SPA (a public client cannot hold a secret, and the implicit
 * flow leaks tokens through the URL).
 *
 * It delegates to `oidc-client-ts` rather than hand-rolling the flow. PKCE verifier generation,
 * `state` and `nonce` validation, the code exchange, refresh-token rotation and the hidden-iframe
 * silent renew are all security-critical and all easy to get subtly wrong; that library is the
 * de-facto standard implementation (the successor to `oidc-client`, maintained by the same
 * community that maintains the certified `angular-auth-oidc-client` ecosystem) and is 30 kB
 * against Firebase's several hundred.
 */
export interface OidcProviderDeps {
  /**
   * Where tokens and in-flight PKCE state live. Defaults to `localStorage` so a reload keeps
   * the session; injectable so the live check script can drive the real provider outside a
   * browser.
   */
  storage?: Storage
}

/** Fallback landing page when the redirect carries no `returnTo`. */
const DEFAULT_RETURN_TO = '/flags'

function returnToFrom(state: unknown): string {
  if (typeof state === 'object' && state !== null) {
    const value = (state as { returnTo?: unknown }).returnTo
    // Only same-origin paths: an absolute URL here would be an open redirect.
    if (typeof value === 'string' && value.startsWith('/') && !value.startsWith('//')) return value
  }
  return DEFAULT_RETURN_TO
}

export function createOidcAuthProvider(
  config: OidcAuthConfig,
  deps: OidcProviderDeps = {},
): DashboardAuthProvider {
  const store = deps.storage ?? (typeof localStorage === 'undefined' ? undefined : localStorage)
  if (!store) throw new Error('The OIDC auth provider needs web storage or an injected store')

  const manager = new UserManager(oidcSettings(config, store))
  const listeners = new Set<(user: AuthUser | null) => void>()
  let current: AuthUser | null = null
  let ready: Promise<void> | null = null

  function publish(user: User | null): void {
    current = oidcToAuthUser(user)
    for (const listener of listeners) listener(current)
  }

  async function start(): Promise<void> {
    manager.events.addUserLoaded((user) => publish(user))
    manager.events.addUserUnloaded(() => publish(null))
    manager.events.addUserSignedOut(() => {
      // The IdP ended the session behind our back. Drop the local copy so the app agrees.
      void manager.removeUser()
    })
    manager.events.addSilentRenewError(() => {
      // A failed renew is not a sign-out on its own: the current token may still be valid, and
      // `getIdToken` re-attempts a silent renew on demand. Leaving state alone avoids bouncing
      // someone to /login over one flaky iframe.
    })
    publish(await manager.getUser())
  }

  return {
    kind: 'oidc',

    init(): Promise<void> {
      ready ??= start()
      return ready
    },

    async signIn(credentials?: SignInOptions): Promise<void> {
      // Navigates away; the promise only settles if the redirect fails to start.
      await manager.signinRedirect({
        state: { returnTo: credentials?.returnTo ?? DEFAULT_RETURN_TO },
      })
    },

    async signOut(): Promise<void> {
      // Prefer RP-initiated logout so the IdP session ends too — otherwise "sign out" followed
      // by "sign in" silently signs the same person straight back in. Not every IdP publishes
      // an end-session endpoint, and Cognito's is non-standard, so fall back to a local drop.
      try {
        const metadata = await manager.metadataService.getMetadata()
        if (metadata.end_session_endpoint) {
          await manager.signoutRedirect()
          return
        }
      } catch {
        /* discovery unreachable — a local sign-out is still better than none */
      }
      await manager.removeUser()
    },

    async getIdToken(forceRefresh = false): Promise<string | null> {
      let user = await manager.getUser()
      if (forceRefresh || !user || user.expired) {
        try {
          user = await manager.signinSilent()
        } catch {
          // Renew failed (no refresh token, IdP session gone, iframe blocked). Fall through:
          // an unexpired token in hand is still worth sending.
          if (forceRefresh || !user || user.expired) return null
        }
      }
      return user ? tokenFor(user, config) : null
    },

    onAuthStateChanged(cb: (user: AuthUser | null) => void): () => void {
      listeners.add(cb)
      cb(current)
      return () => {
        listeners.delete(cb)
      }
    },

    async handleRedirectCallback(): Promise<RedirectResult> {
      const user = await manager.signinRedirectCallback()
      publish(user)
      return { returnTo: returnToFrom(user.state) }
    },

    async handleSilentRenewCallback(): Promise<void> {
      await manager.signinSilentCallback()
    },
  }
}
