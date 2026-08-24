import { createContext } from 'react'
import type { User as FirebaseUser } from 'firebase/auth'
import type { User } from '@/types/api'

export interface AuthState {
  /** Firebase identity — the token source. */
  firebaseUser: FirebaseUser | null
  /** Switchboard identity from `/api/users/me` (auto-provisions on first call). */
  profile: User | null
  loading: boolean
  /** Set when the Firebase session is good but `/api/users/me` failed. */
  profileError: string | null
  reloadProfile: () => Promise<void>
  signOut: () => Promise<void>
}

// The context object lives apart from the provider component so the provider file exports
// only components (react-refresh) and the hook can import the context without a cycle.
export const AuthContext = createContext<AuthState | null>(null)
