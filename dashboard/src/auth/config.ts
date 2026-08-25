import { buildTimeConflict, configSource } from '../lib/runtimeConfig'
import type { AuthProviderKind } from './types'

/**
 * Auth configuration, read at startup from the runtime source (`config.js` layered over the
 * Vite env — see `lib/runtimeConfig.ts`).
 *
 * This is deliberately a *validating* reader rather than a bag of `import.meta.env` lookups
 * scattered through the providers: a deployment that points at Okta and forgets the client id
 * should be told so on the first paint, not discover it as a blank page when someone clicks
 * "Sign in".
 */

export class AuthConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AuthConfigError'
  }
}

export interface FirebaseAuthConfig {
  kind: 'firebase'
  providerName: string
  firebase: {
    apiKey: string
    authDomain: string
    projectId: string
    appId: string
  }
  /** Non-null when pointing at the local Firebase Auth emulator. */
  authEmulatorHost: string | null
}

export interface OidcAuthConfig {
  kind: 'oidc'
  providerName: string
  authority: string
  clientId: string
  scope: string
  /**
   * The API audience, when the IdP issues resource-scoped access tokens (Auth0, Okta, Cognito).
   * Its presence also decides *which* token is sent to Switchboard — see `tokenFor`.
   */
  audience: string | null
  redirectUri: string
  silentRedirectUri: string
  postLogoutRedirectUri: string
}

export type AuthConfig = FirebaseAuthConfig | OidcAuthConfig

/** The subset of `import.meta.env` this module reads. */
export type EnvSource = Record<string, string | boolean | undefined>

const DEFAULT_SCOPE = 'openid profile email'
const KINDS: AuthProviderKind[] = ['firebase', 'oidc']

function str(source: EnvSource, key: string): string | undefined {
  const value = source[key]
  return typeof value === 'string' ? value : undefined
}

function required(source: EnvSource, key: string): string {
  const value = str(source, key)?.trim()
  if (!value) {
    throw new AuthConfigError(
      `${key} is required when VITE_AUTH_PROVIDER=oidc. Set it in .env.local (see .env.example), ` +
        'or in the deployed container\'s environment (see docs/DEPLOYMENT.md).',
    )
  }
  return value
}

function readKind(source: EnvSource): AuthProviderKind {
  const raw = str(source, 'VITE_AUTH_PROVIDER')?.trim()
  // Unset means Firebase: the local stack runs from a clean checkout with no .env at all.
  if (!raw) return 'firebase'
  if (!KINDS.includes(raw as AuthProviderKind)) {
    throw new AuthConfigError(
      `VITE_AUTH_PROVIDER is "${raw}". Expected one of: ${KINDS.join(', ')}.`,
    )
  }
  return raw as AuthProviderKind
}

/** `https://acme.okta.com/oauth2/default` → `acme.okta.com`, for the sign-in button label. */
function nameFromAuthority(authority: string): string {
  try {
    return new URL(authority).hostname.replace(/^www\./, '')
  } catch {
    return authority
  }
}

function readOidc(source: EnvSource, origin: string): OidcAuthConfig {
  const authority = required(source, 'VITE_OIDC_AUTHORITY')
  let parsed: URL
  try {
    parsed = new URL(authority)
  } catch {
    throw new AuthConfigError(
      `VITE_OIDC_AUTHORITY is "${authority}", which is not an absolute URL. ` +
        'Use the issuer exactly as it appears in the token\'s `iss` claim, e.g. ' +
        'https://acme.okta.com/oauth2/default.',
    )
  }
  if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') {
    throw new AuthConfigError(
      `VITE_OIDC_AUTHORITY is "${authority}". A non-localhost issuer must be https.`,
    )
  }
  return {
    kind: 'oidc',
    providerName: str(source, 'VITE_OIDC_PROVIDER_NAME')?.trim() || nameFromAuthority(authority),
    authority,
    clientId: required(source, 'VITE_OIDC_CLIENT_ID'),
    scope: str(source, 'VITE_OIDC_SCOPE')?.trim() || DEFAULT_SCOPE,
    audience: str(source, 'VITE_OIDC_AUDIENCE')?.trim() || null,
    redirectUri: str(source, 'VITE_OIDC_REDIRECT_URI')?.trim() || `${origin}/auth/callback`,
    silentRedirectUri:
      str(source, 'VITE_OIDC_SILENT_REDIRECT_URI')?.trim() || `${origin}/auth/silent-callback`,
    postLogoutRedirectUri:
      str(source, 'VITE_OIDC_POST_LOGOUT_REDIRECT_URI')?.trim() || `${origin}/login`,
  }
}

function readFirebase(source: EnvSource): FirebaseAuthConfig {
  const emulator = str(source, 'VITE_FIREBASE_AUTH_EMULATOR_HOST') ?? 'http://localhost:29099'
  return {
    kind: 'firebase',
    providerName: str(source, 'VITE_FIREBASE_PROVIDER_NAME')?.trim() || 'Firebase',
    firebase: {
      // The emulator ignores the key's value but the SDK requires a non-empty one.
      apiKey: str(source, 'VITE_FIREBASE_API_KEY') || 'demo-api-key',
      authDomain: str(source, 'VITE_FIREBASE_AUTH_DOMAIN') || 'demo-switchboard.firebaseapp.com',
      projectId: str(source, 'VITE_FIREBASE_PROJECT_ID') || 'demo-switchboard',
      appId: str(source, 'VITE_FIREBASE_APP_ID') || 'demo-app-id',
    },
    // Blank means real Firebase.
    authEmulatorHost: emulator.trim() ? emulator.trim() : null,
  }
}

/**
 * Reads and validates the active auth configuration. Throws `AuthConfigError` with a message
 * naming the offending variable — the browser equivalent of the backend refusing to boot on a
 * malformed `switchboard.auth.providers` entry.
 *
 * This is also where a runtime override of a build-time-only key surfaces. It is checked here
 * rather than where it is read because this is the one configuration path with a full-screen
 * error already wired to it (`AuthProvider`), and the only build-time-only key there is decides
 * which auth provider was compiled in.
 */
export function readAuthConfig(
  source: EnvSource = configSource(),
  origin: string = typeof window === 'undefined' ? 'http://localhost:5273' : window.location.origin,
): AuthConfig {
  const conflict = buildTimeConflict()
  if (conflict) throw new AuthConfigError(conflict)
  return readKind(source) === 'oidc' ? readOidc(source, origin) : readFirebase(source)
}
