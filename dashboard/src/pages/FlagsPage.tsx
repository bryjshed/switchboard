import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Flag, Plus, RefreshCw, Search, Sparkles, X } from 'lucide-react'
import { PageHeading } from '@/components/layout/PageHeading'
import { Button } from '@/components/ui/button'
import { usePermissionGate } from '@/hooks/usePermissions'
import { Input } from '@/components/ui/input'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { FlagEnvStateChip } from '@/components/FlagEnvStateChip'
import { EmptyState } from '@/components/EmptyState'
import { NewFlagDialog } from './flags/NewFlagDialog'
import { AskAiDialog } from './ai/AskAiDialog'
import { listFlags } from '@/lib/flagsApi'
import { errorMessage } from '@/lib/apiClient'
import { sortEnvKeys } from '@/lib/envColors'
import { formatDateTime, formatRelative, latestChange } from '@/lib/format'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { FlagSummary } from '@/types/api'

export function FlagsPage() {
  const writeGate = usePermissionGate('FLAG_WRITE')
  const navigate = useNavigate()
  const { project, loading: workspaceLoading } = useWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  const [flags, setFlags] = useState<FlagSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [askOpen, setAskOpen] = useState(false)
  // Which project the table currently holds data for, so a filter change refreshes in place
  // rather than falling back to the loading skeletons.
  const loadedProjectId = useRef<string | null>(null)

  // Search and the tag filter live in the URL so a filtered list is linkable and survives
  // a reload — same convention as `?tab=` on the detail page.
  const query = searchParams.get('q') ?? ''
  const tag = searchParams.get('tag') ?? ''

  const setParam = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value) next.set(key, value)
          else next.delete(key)
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const load = useCallback(
    async (projectId: string, opts: { refresh?: boolean } = {}) => {
      if (opts.refresh) setRefreshing(true)
      setError(null)
      try {
        // The backend does the filtering so paging stays correct; the client never
        // re-filters a partial page.
        const res = await listFlags(projectId, { query: query || undefined, tag: tag || undefined })
        setFlags(res.items)
      } catch (err) {
        setError(errorMessage(err, 'Could not load flags'))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [query, tag],
  )

  useEffect(() => {
    if (!project) {
      if (!workspaceLoading) setLoading(false)
      return
    }
    // Skeletons only on the first load of a project. Re-running for a changed search term
    // marks the table as refreshing instead, so typing does not blank out the results.
    const isFirstLoad = loadedProjectId.current !== project.id
    if (isFirstLoad) setLoading(true)
    // Debounce so typing in the search box does not fire a request per keystroke.
    const handle = setTimeout(() => {
      loadedProjectId.current = project.id
      void load(project.id, { refresh: !isFirstLoad })
    }, isFirstLoad ? 0 : 200)
    // `loadedProjectId` is a ref on purpose: reading it must not retrigger this effect.
    return () => clearTimeout(handle)
  }, [project, workspaceLoading, load])

  // Column order for the per-environment chips: the project's environments, canonically
  // ordered, so every row lines up even when a flag lacks a summary for one of them.
  const envKeys = useMemo(
    () => (project ? sortEnvKeys(project.environments, (e) => e.key).map((e) => e.key) : []),
    [project],
  )

  const allTags = useMemo(() => {
    const set = new Set<string>()
    flags.forEach((f) => f.tags.forEach((t) => set.add(t)))
    return [...set].sort()
  }, [flags])

  if (!workspaceLoading && !project) {
    return (
      <div className="space-y-6">
        <PageHeading title="Flags" />
        <EmptyState
          icon={Flag}
          title="No project selected"
          description="Pick a project in the header, or create one to get started."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeading
          title="Flags"
          description={
            project
              ? `Feature flags in ${project.name}. Each chip is one environment's live state.`
              : undefined
          }
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh"
            data-testid="flags-refresh"
            disabled={!project || refreshing}
            onClick={() => project && void load(project.id, { refresh: true })}
          >
            <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
          <Button
            variant="outline"
            data-testid="flags-ask-ai"
            disabled={!project}
            onClick={() => setAskOpen(true)}
          >
            <Sparkles className="mr-1 h-4 w-4" /> Ask AI
          </Button>
          <Button
            data-testid="new-flag"
            disabled={!project || !writeGate.allowed}
            title={writeGate.allowed ? undefined : writeGate.reason}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1 h-4 w-4" /> New flag
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full max-w-sm">
          <Search
            className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            className="pl-8"
            data-testid="flags-search"
            aria-label="Search flags by key or name"
            placeholder="Search by key or name"
            value={query}
            onChange={(e) => setParam('q', e.target.value)}
          />
        </div>
        {tag && (
          <Button
            variant="secondary"
            size="sm"
            data-testid="flags-clear-tag"
            onClick={() => setParam('tag', '')}
          >
            tag: {tag}
            <X className="ml-1 h-3 w-3" />
          </Button>
        )}
        {!tag && allTags.length > 0 && (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">Filter by tag:</span>
            {allTags.map((t) => (
              <button
                key={t}
                type="button"
                data-testid={`flags-tag-${t}`}
                onClick={() => setParam('tag', t)}
                className="rounded-full border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : flags.length === 0 ? (
        <EmptyState
          icon={Flag}
          title={query || tag ? 'No flags match that filter' : 'No flags yet'}
          description={
            query || tag
              ? 'Try a different search term or clear the tag filter.'
              : 'Create your first flag to start shipping behind a switch.'
          }
          action={
            !query &&
            !tag && (
              <Button disabled={!writeGate.allowed} onClick={() => setCreateOpen(true)}>
                <Plus className="mr-1 h-4 w-4" /> New flag
              </Button>
            )
          }
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Flag</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>Environments</TableHead>
                <TableHead className="text-right">Last changed</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {flags.map((flag) => {
                const change = latestChange(flag.environments)
                return (
                  <TableRow
                    key={flag.id}
                    data-testid={`flag-row-${flag.key}`}
                    tabIndex={0}
                    role="link"
                    aria-label={`Open ${flag.name}`}
                    className="cursor-pointer"
                    onClick={() => navigate(`/flags/${encodeURIComponent(flag.key)}`)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault()
                        navigate(`/flags/${encodeURIComponent(flag.key)}`)
                      }
                    }}
                  >
                    <TableCell>
                      <div className="font-mono text-sm">{flag.key}</div>
                      <div className="text-xs text-muted-foreground">{flag.name}</div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1">
                        {flag.kind === 'STRING' && (
                          <Badge variant="secondary" className="text-[10px]">
                            multivariate
                          </Badge>
                        )}
                        {flag.tags.map((t) => (
                          <Badge key={t} variant="outline" className="text-[10px]">
                            {t}
                          </Badge>
                        ))}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="flex flex-wrap gap-1.5">
                        {envKeys.map((envKey) => {
                          const summary = flag.environments.find((e) => e.envKey === envKey)
                          if (!summary) return null
                          return <FlagEnvStateChip key={envKey} summary={summary} />
                        })}
                      </div>
                    </TableCell>
                    <TableCell className="text-right">
                      <div className="text-sm" title={change.updatedAt ?? undefined}>
                        {formatRelative(change.updatedAt)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {change.updatedBy ?? formatDateTime(change.updatedAt)}
                      </div>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      {project && (
        <>
          <NewFlagDialog
            projectId={project.id}
            open={createOpen}
            onOpenChange={setCreateOpen}
            onCreated={(flag) => navigate(`/flags/${encodeURIComponent(flag.key)}`)}
          />
          <AskAiDialog
            projectId={project.id}
            open={askOpen}
            onOpenChange={setAskOpen}
            onApplied={(proposal) =>
              navigate(`/flags/${encodeURIComponent(proposal.diff.flagKey)}`)
            }
          />
        </>
      )}
    </div>
  )
}
