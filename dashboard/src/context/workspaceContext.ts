import { createContext } from 'react'
import type { Environment, Org, Project } from '@/types/api'

export interface WorkspaceState {
  orgs: Org[]
  org: Org | null
  projects: Project[]
  project: Project | null
  /** Environments of the selected project, in canonical dev → staging → production order. */
  environments: Environment[]
  environment: Environment | null
  loading: boolean
  error: string | null
  selectOrg: (orgId: string) => void
  selectProject: (projectId: string) => void
  selectEnvironment: (envKey: string) => void
  /** Re-reads orgs/projects/environments — call after creating or renaming any of them. */
  refresh: () => Promise<void>
  /**
   * Re-reads the workspace and lands on the given org (and project, when named) — call after
   * creating one, so the new thing is selected rather than merely listed. A project omitted
   * falls back to the org's first, like any other org switch.
   */
  adopt: (orgId: string, projectId?: string) => Promise<void>
  /**
   * True once the workspace has loaded and the caller belongs to no org at all. The app shell
   * shows the first-run screen instead of a page, because every page needs an org.
   */
  needsOrg: boolean
}

export const WorkspaceContext = createContext<WorkspaceState | null>(null)

export const WORKSPACE_STORAGE_KEYS = {
  org: 'switchboard.orgId',
  project: 'switchboard.projectId',
  environment: 'switchboard.envKey',
} as const
