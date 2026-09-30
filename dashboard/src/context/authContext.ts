import { createContext } from 'react'
import type { AuthProviderKind, AuthUser, SignInOptions } from '@/auth'
import type { User } from '@/types/api'

export interface AuthState {
  /** The signed-in identity from the active auth provider — the token source. */
  user: AuthUser | null
  /** Which implementation is live, so the login page can render the right affordance. */
  providerKind: AuthProviderKind
  /** Display name for that provider ("Firebase", "acme.okta.com"). */
  providerName: string
  /** True only on the Firebase path when pointed at the local emulator. */
  usingAuthEmulator: boolean
  /** Switchboard identity from `/api/users/me` (auto-provisions on first call). */
  profile: User | null
  loading: boolean
  /** Set when the session is good but `/api/users/me` failed. */
  profileError: string | null
  /** Set when auth could not start at all — bad configuration, SDK failed to load. */
  authError: string | null
  /**
   * Whether the provider vouches for the signed-in email; null when it does not say. Pending
   * org invitations are accepted only for a verified address.
   */
  emailVerified: boolean | null
  /** Present only when the provider can send one (Firebase). Absent → hide the control. */
  sendEmailVerification?: () => Promise<void>
  /**
   * Present only when the provider supports it. Re-reads the identity and forces a fresh token,
   * then updates `user`; call `reloadProfile` afterwards to have the backend see the change.
   */
  refreshToken?: () => Promise<void>
  signIn: (credentials?: SignInOptions) => Promise<void>
  reloadProfile: () => Promise<void>
  signOut: () => Promise<void>
}

// The context object lives apart from the provider component so the provider file exports
// only components (react-refresh) and the hook can import the context without a cycle.
export const AuthContext = createContext<AuthState | null>(null)
