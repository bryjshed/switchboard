import { useCallback, useEffect, useMemo, useState } from 'react'
import { listOrgs } from '@/lib/orgsApi'
import { listProjects } from '@/lib/projectsApi'
import { errorMessage } from '@/lib/apiClient'
import { sortEnvKeys } from '@/lib/envColors'
import { useAuth } from '@/hooks/useAuth'
import type { Org, Project } from '@/types/api'
import { WORKSPACE_STORAGE_KEYS, WorkspaceContext } from './workspaceContext'

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    // Private-mode browsers can throw on access; a missing preference is not fatal.
    return null
  }
}

function writeStored(key: string, value: string | null) {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch {
    /* preference is a convenience, never a requirement */
  }
}

/**
 * Owns the org → project → environment selection that every page reads. Selections persist
 * to localStorage so a reload lands you back where you were, but a persisted id that is no
 * longer visible to you (org switched, project deleted, a different account signed in)
 * silently falls back to the first available rather than wedging the app on a 403.
 */
export function WorkspaceProvider({ children }: { children: React.ReactNode }) {
  const { profile } = useAuth()
  const [orgs, setOrgs] = useState<Org[]>([])
  const [projects, setProjects] = useState<Project[]>([])
  const [orgId, setOrgId] = useState<string | null>(() => readStored(WORKSPACE_STORAGE_KEYS.org))
  const [projectId, setProjectId] = useState<string | null>(() =>
    readStored(WORKSPACE_STORAGE_KEYS.project),
  )
  const [envKey, setEnvKey] = useState<string | null>(() =>
    readStored(WORKSPACE_STORAGE_KEYS.environment),
  )
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const nextOrgs = await listOrgs()
      setOrgs(nextOrgs)
      const stored = readStored(WORKSPACE_STORAGE_KEYS.org)
      const resolvedOrg = nextOrgs.find((o) => o.id === stored) ?? nextOrgs[0] ?? null
      setOrgId(resolvedOrg?.id ?? null)
      if (!resolvedOrg) {
        setProjects([])
        return
      }
      const nextProjects = await listProjects(resolvedOrg.id)
      setProjects(nextProjects)
      const storedProject = readStored(WORKSPACE_STORAGE_KEYS.project)
      const resolvedProject =
        nextProjects.find((p) => p.id === storedProject) ?? nextProjects[0] ?? null
      setProjectId(resolvedProject?.id ?? null)
    } catch (err) {
      setError(errorMessage(err, 'Could not load your workspace'))
    }
  }, [])

  useEffect(() => {
    if (!profile) {
      setLoading(false)
      return
    }
    setLoading(true)
    void load().finally(() => setLoading(false))
  }, [profile, load])

  const org = useMemo(() => orgs.find((o) => o.id === orgId) ?? null, [orgs, orgId])
  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId])

  // Archived environments are filtered out here, which is what makes archiving mean anything:
  // this list feeds the environment picker and every per-environment screen. The API returns
  // them on purpose - they still own their configs and history - so Settings -> Environments
  // reads project.environments directly in order to offer a restore.
  const environments = useMemo(
    () =>
      project
        ? sortEnvKeys(
            project.environments.filter((e) => !e.archivedAt),
            (e) => e.key,
          )
        : [],
    [project],
  )

  const environment = useMemo(
    () => environments.find((e) => e.key === envKey) ?? environments[0] ?? null,
    [environments, envKey],
  )

  // Keep the persisted env key honest when the resolved environment differs from what was
  // stored (project switch, environment removed).
  useEffect(() => {
    if (environment && environment.key !== envKey) {
      setEnvKey(environment.key)
      writeStored(WORKSPACE_STORAGE_KEYS.environment, environment.key)
    }
  }, [environment, envKey])

  const selectOrg = useCallback(
    (nextOrgId: string) => {
      setOrgId(nextOrgId)
      writeStored(WORKSPACE_STORAGE_KEYS.org, nextOrgId)
      // Project and environment belong to the old org; clear before reloading.
      setProjectId(null)
      writeStored(WORKSPACE_STORAGE_KEYS.project, null)
      setProjects([])
      setLoading(true)
      void (async () => {
        try {
          const nextProjects = await listProjects(nextOrgId)
          setProjects(nextProjects)
          const first = nextProjects[0] ?? null
          setProjectId(first?.id ?? null)
          writeStored(WORKSPACE_STORAGE_KEYS.project, first?.id ?? null)
        } catch (err) {
          setError(errorMessage(err, 'Could not load projects for that organization'))
        } finally {
          setLoading(false)
        }
      })()
    },
    [],
  )

  const selectProject = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId)
    writeStored(WORKSPACE_STORAGE_KEYS.project, nextProjectId)
  }, [])

  const selectEnvironment = useCallback((nextEnvKey: string) => {
    setEnvKey(nextEnvKey)
    writeStored(WORKSPACE_STORAGE_KEYS.environment, nextEnvKey)
  }, [])

  return (
    <WorkspaceContext.Provider
      value={{
        orgs,
        org,
        projects,
        project,
        environments,
        environment,
        loading,
        error,
        selectOrg,
        selectProject,
        selectEnvironment,
        refresh: load,
      }}
    >
      {children}
    </WorkspaceContext.Provider>
  )
}
