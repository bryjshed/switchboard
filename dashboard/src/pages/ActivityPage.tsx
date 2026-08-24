import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { RefreshCw, ScrollText, Sparkles } from 'lucide-react'
import { PageHeading } from '@/components/layout/PageHeading'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/components/EmptyState'
import { EnvChip } from '@/components/EnvChip'
import { listOrgAudit, listProjectAudit } from '@/lib/auditApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime, formatRelative } from '@/lib/format'
import { auditActionMeta, groupByDay } from '@/lib/auditDisplay'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { AuditEntry } from '@/types/api'

const PAGE_SIZE = 50

export function ActivityPage() {
  const { org, projects, environments, loading: workspaceLoading } = useWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  const [entries, setEntries] = useState<AuditEntry[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadedOrg = useRef<string | null>(null)

  // Filters live in the URL: "what happened to checkout in production yesterday" is a link
  // you send someone, not a set of clicks you describe to them.
  const projectFilter = searchParams.get('project') ?? ''
  const envFilter = searchParams.get('env') ?? ''
  const flagFilter = searchParams.get('flag') ?? ''

  const setParam = useCallback(
    (key: string, value: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          if (value) next.set(key, value)
          else next.delete(key)
          // The env and flag filters only exist on the project endpoint.
          if (key === 'project' && !value) {
            next.delete('env')
            next.delete('flag')
          }
          return next
        },
        { replace: true },
      )
    },
    [setSearchParams],
  )

  const fetchPage = useCallback(
    (cursor?: string) => {
      if (projectFilter) {
        return listProjectAudit(projectFilter, {
          env: envFilter || undefined,
          flagKey: flagFilter || undefined,
          cursor,
          limit: PAGE_SIZE,
        })
      }
      if (!org) throw new Error('No organization selected')
      return listOrgAudit(org.id, { cursor, limit: PAGE_SIZE })
    },
    [org, projectFilter, envFilter, flagFilter],
  )

  const load = useCallback(
    async (opts: { refresh?: boolean } = {}) => {
      if (opts.refresh) setRefreshing(true)
      setError(null)
      try {
        const res = await fetchPage()
        setEntries(res.items)
        setNextCursor(res.nextCursor)
      } catch (err) {
        setError(errorMessage(err, 'Could not load activity'))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [fetchPage],
  )

  useEffect(() => {
    if (!org) {
      if (!workspaceLoading) setLoading(false)
      return
    }
    const isFirstLoad = loadedOrg.current !== org.id
    if (isFirstLoad) setLoading(true)
    // Debounced so typing a flag key does not fire a request per keystroke.
    const handle = setTimeout(
      () => {
        loadedOrg.current = org.id
        void load({ refresh: !isFirstLoad })
      },
      isFirstLoad ? 0 : 250,
    )
    return () => clearTimeout(handle)
  }, [org, workspaceLoading, load])

  const loadMore = async () => {
    if (!nextCursor) return
    setLoadingMore(true)
    try {
      const res = await fetchPage(nextCursor)
      setEntries((prev) => [...prev, ...res.items])
      setNextCursor(res.nextCursor)
    } catch (err) {
      setError(errorMessage(err, 'Could not load more activity'))
    } finally {
      setLoadingMore(false)
    }
  }

  if (!workspaceLoading && !org) {
    return (
      <div className="space-y-6">
        <PageHeading title="Activity" />
        <EmptyState icon={ScrollText} title="No organization selected" />
      </div>
    )
  }

  const filterEnvs = projectFilter
    ? (projects.find((p) => p.id === projectFilter)?.environments ?? environments)
    : []
  const days = groupByDay(entries)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeading
          title="Activity"
          description="Every change to every flag, segment and key in this organization, newest first. Changes the AI layer made are marked as such."
        />
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh"
          data-testid="activity-refresh"
          disabled={refreshing}
          onClick={() => void load({ refresh: true })}
        >
          <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <Select
          value={projectFilter || 'all'}
          onValueChange={(v) => setParam('project', v === 'all' ? '' : v)}
        >
          <SelectTrigger className="w-56" data-testid="activity-project" aria-label="Filter by project">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All projects</SelectItem>
            {projects.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={envFilter || 'all'}
          onValueChange={(v) => setParam('env', v === 'all' ? '' : v)}
          disabled={!projectFilter}
        >
          <SelectTrigger
            className="w-44"
            data-testid="activity-env"
            aria-label="Filter by environment"
          >
            <SelectValue placeholder="All environments" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All environments</SelectItem>
            {filterEnvs.map((env) => (
              <SelectItem key={env.id} value={env.key}>
                {env.key}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Input
          className="w-56"
          data-testid="activity-flag"
          aria-label="Filter by flag key"
          placeholder="Flag key"
          disabled={!projectFilter}
          value={flagFilter}
          onChange={(e) => setParam('flag', e.target.value)}
        />

        {!projectFilter && (
          <p className="text-xs text-muted-foreground">
            Pick a project to filter by environment or flag.
          </p>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title="Nothing recorded yet"
          description={
            projectFilter || envFilter || flagFilter
              ? 'No entries match these filters.'
              : 'Changes appear here the moment anyone — or anything — touches a flag.'
          }
        />
      ) : (
        <div className="space-y-6" data-testid="activity-feed">
          {days.map(({ day, label, items }) => (
            <section key={day} className="space-y-2">
              <h3 className="sticky top-0 z-10 bg-background py-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                {label}
              </h3>
              <ul className="divide-y rounded-md border">
                {items.map((entry) => {
                  const meta = auditActionMeta(entry.action)
                  return (
                    <li
                      key={entry.id}
                      data-testid={`activity-${entry.id}`}
                      className="flex flex-wrap items-center gap-x-3 gap-y-1 p-3"
                    >
                      <Badge variant={meta.variant} data-testid={`activity-action-${entry.action}`}>
                        {meta.automatic && (
                          <Sparkles className="mr-1 h-3 w-3 shrink-0" aria-hidden />
                        )}
                        {meta.label}
                      </Badge>
                      {entry.flagKey && (
                        <Link
                          to={`/flags/${encodeURIComponent(entry.flagKey)}`}
                          className="font-mono text-sm underline-offset-2 hover:underline"
                        >
                          {entry.flagKey}
                        </Link>
                      )}
                      {entry.envKey && <EnvChip envKey={entry.envKey} />}
                      {entry.versionFrom != null && entry.versionTo != null && (
                        <span className="font-mono text-xs text-muted-foreground">
                          v{entry.versionFrom} → v{entry.versionTo}
                        </span>
                      )}
                      {entry.reason && (
                        <span className="min-w-0 flex-1 truncate text-sm text-muted-foreground">
                          {entry.reason}
                        </span>
                      )}
                      <span className="ml-auto flex items-center gap-3">
                        <span className="text-xs text-muted-foreground">{entry.actor}</span>
                        <span
                          className="text-xs text-muted-foreground"
                          title={formatDateTime(entry.createdAt)}
                        >
                          {formatRelative(entry.createdAt)}
                        </span>
                      </span>
                    </li>
                  )
                })}
              </ul>
            </section>
          ))}
        </div>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            data-testid="activity-load-more"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
    </div>
  )
}
