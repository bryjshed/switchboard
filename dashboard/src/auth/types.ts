/**
 * The dashboard's auth seam.
 *
 * Switchboard's backend verifies a user by `(issuer, subject)` against whichever provider
 * claims the token's `iss`, so the dashboard has no business knowing that Firebase exists.
 * Everything above this file deals in an `AuthUser` and a `DashboardAuthProvider`; the two
 * implementations (`firebase`, `oidc`) live behind it and are selected by configuration.
 */

export type AuthProviderKind = 'firebase' | 'oidc'

/**
 * A signed-in person, provider-neutral.
 *
 * `subject` is the token's `sub` — the same value the backend stores in
 * `user_identities.subject` — so it is stable per identity but NOT the Switchboard user id.
 * The Switchboard profile comes from `/api/users/me`, which is a separate concern.
 */
export interface AuthUser {
  subject: string
  email: string | null
  displayName: string | null
}

/** Arguments to `signIn`. Which fields matter depends on the active provider. */
export interface SignInOptions {
  /** Firebase only — the password form's email. */
  email?: string
  /** Firebase only — the password form's password. */
  password?: string
  /** OIDC only — where to land once the redirect round-trip completes. */
  returnTo?: string
}

/** Result of completing an OIDC redirect: where the user was originally headed. */
export interface RedirectResult {
  returnTo: string
}

export interface DashboardAuthProvider {
  readonly kind: AuthProviderKind

  /**
   * Bring the provider up: load the SDK, restore any persisted session. Called once, before
   * `onAuthStateChanged` subscribers are attached, and safe to await more than once.
   */
  init(): Promise<void>

  /**
   * Firebase: sign in with the supplied email and password.
   * OIDC: leave for the IdP's authorization endpoint. This navigates away and does not return.
   */
  signIn(credentials?: SignInOptions): Promise<void>

  signOut(): Promise<void>

  /**
   * The bearer token for the management API, or null when nobody is signed in.
   * `forceRefresh` must actually mint a new token — `apiClient` uses it to retry a 401 once.
   */
  getIdToken(forceRefresh?: boolean): Promise<string | null>

  /** Fires immediately with the current state, then on every change. Returns an unsubscribe. */
  onAuthStateChanged(cb: (user: AuthUser | null) => void): () => void

  /** OIDC only: finish the authorization-code exchange on the callback route. */
  handleRedirectCallback?(): Promise<RedirectResult>

  /** OIDC only: finish a silent renew inside the hidden iframe. */
  handleSilentRenewCallback?(): Promise<void>
}
