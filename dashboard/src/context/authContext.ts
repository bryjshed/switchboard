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
  signIn: (credentials?: SignInOptions) => Promise<void>
  reloadProfile: () => Promise<void>
  signOut: () => Promise<void>
}

// The context object lives apart from the provider component so the provider file exports
// only components (react-refresh) and the hook can import the context without a cycle.
export const AuthContext = createContext<AuthState | null>(null)
