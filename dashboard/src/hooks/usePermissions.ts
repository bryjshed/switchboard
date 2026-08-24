import { useContext } from 'react'
import { PermissionsContext, type PermissionsState } from '@/context/permissionsContext'
import { missingPermissionReason } from '@/lib/permissions'
import type { Permission } from '@/types/api'

export function usePermissions(): PermissionsState {
  const ctx = useContext(PermissionsContext)
  if (!ctx) throw new Error('usePermissions must be used inside <PermissionsProvider>')
  return ctx
}

export interface PermissionGate {
  /** True when the viewer holds the permission at the active scope. */
  allowed: boolean
  /** True while the answer is still being fetched — render a control disabled, not hidden. */
  loading: boolean
  /** Why the control is unavailable, in words. Empty string when allowed. */
  reason: string
}

/**
 * The disable-with-an-explanation half of permission gating, for controls that should stay
 * visible so the page does not rearrange itself under people who cannot use every button.
 * `<RequirePermission>` is the hide-or-replace half; both read the same source.
 */
export function usePermissionGate(permission: Permission): PermissionGate {
  const { has, loading, scopeType, scopeName } = usePermissions()
  const allowed = has(permission)
  return {
    allowed,
    loading,
    reason: allowed
      ? ''
      : loading
        ? 'Checking your permissions…'
        : missingPermissionReason(permission, scopeType, scopeName),
  }
}
