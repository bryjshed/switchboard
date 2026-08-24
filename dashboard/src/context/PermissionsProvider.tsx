import { useCallback, useEffect, useMemo, useState } from 'react'
import { getMyPermissions, type PermissionScopeQuery } from '@/lib/accessApi'
import { errorMessage } from '@/lib/apiClient'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { Permission, ScopeType } from '@/types/api'
import { PermissionsContext } from './permissionsContext'

/**
 * The caller's effective permissions for whatever the workspace currently has selected.
 *
 * Asked ONCE, at the narrowest scope available — the selected environment, else the project,
 * else the org. Permissions union across containing scopes, so the environment answer
 * already includes everything granted at the project and the org; asking three times would
 * produce the same set and three round trips.
 *
 * This exists so people are not offered buttons that will 403. It is not a security boundary
 * — the backend checks every one of these again — and no code here should ever be the only
 * thing standing between a user and an action.
 */
export function PermissionsProvider({ children }: { children: React.ReactNode }) {
  const { org, project, environment, loading: workspaceLoading } = useWorkspace()
  const [permissions, setPermissions] = useState<ReadonlySet<Permission> | null>(null)
  const [scopeType, setScopeType] = useState<ScopeType | null>(null)
  const [scopeId, setScopeId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // The narrowest scope the workspace can name right now, and the name to put in a caption.
  const target = useMemo((): { query: PermissionScopeQuery; name: string | null } | null => {
    if (environment) return { query: { envId: environment.id }, name: environment.name }
    if (project) return { query: { projectId: project.id }, name: project.name }
    if (org) return { query: { orgId: org.id }, name: org.name }
    return null
  }, [org, project, environment])

  const scopeName = target?.name ?? null
  const queryKey = target ? JSON.stringify(target.query) : null

  const load = useCallback(async () => {
    if (!queryKey) {
      setPermissions(null)
      setScopeType(null)
      setScopeId(null)
      setLoading(false)
      return
    }
    setError(null)
    try {
      const res = await getMyPermissions(JSON.parse(queryKey) as PermissionScopeQuery)
      setPermissions(new Set(res.permissions))
      setScopeType(res.scopeType)
      setScopeId(res.scopeId)
    } catch (err) {
      // A failed lookup must not silently grant everything. An empty set hides write
      // controls, which is the safe direction to fail in — and the error is surfaced so the
      // reason is visible rather than looking like a demotion.
      setPermissions(new Set())
      setError(errorMessage(err, 'Could not read your permissions'))
    } finally {
      setLoading(false)
    }
  }, [queryKey])

  useEffect(() => {
    if (workspaceLoading && !queryKey) return
    setLoading(true)
    void load()
  }, [load, queryKey, workspaceLoading])

  const has = useCallback(
    (...wanted: Permission[]) =>
      permissions !== null && wanted.every((permission) => permissions.has(permission)),
    [permissions],
  )

  const hasAny = useCallback(
    (...wanted: Permission[]) =>
      permissions !== null && wanted.some((permission) => permissions.has(permission)),
    [permissions],
  )

  const value = useMemo(
    () => ({
      permissions,
      scopeType,
      scopeId,
      scopeName,
      loading,
      error,
      has,
      hasAny,
      refresh: load,
    }),
    [permissions, scopeType, scopeId, scopeName, loading, error, has, hasAny, load],
  )

  return <PermissionsContext.Provider value={value}>{children}</PermissionsContext.Provider>
}
