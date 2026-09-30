import { useState } from 'react'
import { ChevronRight, Plus } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EnvDot } from '@/components/EnvChip'
import { CreateOrgDialog } from '@/components/workspace/CreateOrgDialog'
import { CreateProjectDialog } from '@/components/workspace/CreateProjectDialog'
import { useAuth } from '@/hooks/useAuth'
import { usePermissions } from '@/hooks/usePermissions'
import { useWorkspace } from '@/hooks/useWorkspace'
import { Skeleton } from '@/components/ui/skeleton'

// Sentinel values for the "New …" entries. Real ids are uuids, so these cannot collide.
const NEW_ORG_VALUE = '__new_org__'
const NEW_PROJECT_VALUE = '__new_project__'

/**
 * Org → project → environment breadcrumb of selects. Selection is owned (and persisted) by
 * the workspace provider so every page reads the same one.
 *
 * The org and project selects end in a "New …" entry that opens the matching dialog instead
 * of selecting anything. Each is shown only when it would succeed: a new org when the server
 * says this caller may create one (`profile.canCreateOrg`), a new project with MANAGE_PROJECTS.
 */
export function WorkspaceSwitchers() {
  const { profile } = useAuth()
  const { has } = usePermissions()
  const [createOrgOpen, setCreateOrgOpen] = useState(false)
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const {
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
  } = useWorkspace()

  if (loading && !org) {
    return <Skeleton className="h-8 w-96" />
  }

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    )
  }

  const canCreateOrg = profile?.canCreateOrg === true
  const canCreateProject = org !== null && has('MANAGE_PROJECTS')

  const onOrgChange = (value: string) => {
    if (value === NEW_ORG_VALUE) setCreateOrgOpen(true)
    else selectOrg(value)
  }

  const onProjectChange = (value: string) => {
    if (value === NEW_PROJECT_VALUE) setCreateProjectOpen(true)
    else selectProject(value)
  }

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Select value={org?.id ?? ''} onValueChange={onOrgChange}>
        <SelectTrigger
          className="h-8 w-[180px] border-0 bg-transparent font-medium shadow-none hover:bg-accent"
          aria-label="Organization"
          data-testid="org-switcher"
        >
          <SelectValue placeholder="Organization" />
        </SelectTrigger>
        <SelectContent>
          {orgs.map((o) => (
            <SelectItem key={o.id} value={o.id}>
              {o.name}
            </SelectItem>
          ))}
          {canCreateOrg && (
            <>
              {orgs.length > 0 && <SelectSeparator />}
              <SelectItem value={NEW_ORG_VALUE} data-testid="org-switcher-new">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  New organization…
                </span>
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>

      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />

      {/* Disabled only when there is no org to hold a project. An org with no projects yet is
          exactly when "New project…" is needed. */}
      <Select
        value={project?.id ?? ''}
        onValueChange={onProjectChange}
        disabled={!org || (projects.length === 0 && !canCreateProject)}
      >
        <SelectTrigger
          className="h-8 w-[190px] border-0 bg-transparent font-medium shadow-none hover:bg-accent"
          aria-label="Project"
          data-testid="project-switcher"
        >
          <SelectValue placeholder={projects.length === 0 ? 'No projects' : 'Project'} />
        </SelectTrigger>
        <SelectContent>
          {projects.map((p) => (
            <SelectItem key={p.id} value={p.id}>
              {p.name}
            </SelectItem>
          ))}
          {canCreateProject && (
            <>
              {projects.length > 0 && <SelectSeparator />}
              <SelectItem value={NEW_PROJECT_VALUE} data-testid="project-switcher-new">
                <span className="flex items-center gap-2 text-muted-foreground">
                  <Plus className="h-3.5 w-3.5" aria-hidden />
                  New project…
                </span>
              </SelectItem>
            </>
          )}
        </SelectContent>
      </Select>

      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />

      <Select
        value={environment?.key ?? ''}
        onValueChange={selectEnvironment}
        disabled={environments.length === 0}
      >
        <SelectTrigger
          className="h-8 w-[160px] border-0 bg-transparent font-medium shadow-none hover:bg-accent"
          aria-label="Environment"
          data-testid="env-switcher"
        >
          <SelectValue placeholder="Environment" />
        </SelectTrigger>
        <SelectContent>
          {environments.map((e) => (
            <SelectItem key={e.key} value={e.key}>
              <span className="flex items-center gap-2">
                <EnvDot envKey={e.key} />
                {e.name}
              </span>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <CreateOrgDialog open={createOrgOpen} onOpenChange={setCreateOrgOpen} />
      <CreateProjectDialog open={createProjectOpen} onOpenChange={setCreateProjectOpen} />
    </div>
  )
}
