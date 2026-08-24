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
}

export const WorkspaceContext = createContext<WorkspaceState | null>(null)

export const WORKSPACE_STORAGE_KEYS = {
  org: 'switchboard.orgId',
  project: 'switchboard.projectId',
  environment: 'switchboard.envKey',
} as const
