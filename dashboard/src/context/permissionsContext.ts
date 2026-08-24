import { createContext } from 'react'
import type { Permission, ScopeType } from '@/types/api'

export interface PermissionsState {
  /** Effective permissions at `scopeType`/`scopeId`. Null until the first answer arrives. */
  permissions: ReadonlySet<Permission> | null
  /** The scope the set was resolved at — the narrowest the workspace could name. */
  scopeType: ScopeType | null
  scopeId: string | null
  /** Human name of that scope (environment or project name), for captions. */
  scopeName: string | null
  loading: boolean
  error: string | null
  /** True for every permission named. Answers false while still loading — see `loading`. */
  has: (...permissions: Permission[]) => boolean
  /** True for at least one of the permissions named. */
  hasAny: (...permissions: Permission[]) => boolean
  /** Re-reads the caller's permissions. Call after granting or revoking a role. */
  refresh: () => Promise<void>
}

// Separated from the provider component so the provider file exports only components
// (react-refresh) and the hook can import the context without a cycle.
export const PermissionsContext = createContext<PermissionsState | null>(null)
