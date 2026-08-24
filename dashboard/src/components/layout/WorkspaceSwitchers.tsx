import { ChevronRight } from 'lucide-react'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EnvDot } from '@/components/EnvChip'
import { useWorkspace } from '@/hooks/useWorkspace'
import { Skeleton } from '@/components/ui/skeleton'

/**
 * Org → project → environment breadcrumb of selects. Selection is owned (and persisted) by
 * the workspace provider so every page reads the same one.
 */
export function WorkspaceSwitchers() {
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

  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <Select value={org?.id ?? ''} onValueChange={selectOrg}>
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
        </SelectContent>
      </Select>

      <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground/50" aria-hidden />

      <Select value={project?.id ?? ''} onValueChange={selectProject} disabled={projects.length === 0}>
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
    </div>
  )
}
