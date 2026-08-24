import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { GitPullRequest, RefreshCw } from 'lucide-react'
import { PageHeading } from '@/components/layout/PageHeading'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { EmptyState } from '@/components/EmptyState'
import { EnvChip } from '@/components/EnvChip'
import { listChangeRequests } from '@/lib/changeRequestsApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime, formatRelative } from '@/lib/format'
import { describeChangeRequestBriefly } from '@/lib/changeRequestDisplay'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/hooks/useWorkspace'
import { CHANGE_REQUEST_STATUSES } from '@/types/api'
import type { ChangeRequest, ChangeRequestStatus } from '@/types/api'
import { ApprovalProgress, ChangeRequestKindBadge, ChangeRequestStatusBadge } from './changeRequestBadges'

const PAGE_SIZE = 25

function isStatus(value: string | null): value is ChangeRequestStatus {
  return value !== null && (CHANGE_REQUEST_STATUSES as readonly string[]).includes(value)
}

const ALL_ENVS = '__all__'

/**
 * The review queue.
 *
 * Every filter lives in the URL, because the thing you do with this page is send someone a
 * link to it — "the pending requests on production" has to survive being pasted into a chat
 * at 3am. The row is deliberately dense: flag key, what kind of write it is, how close it is
 * to the approval threshold, and a status that cannot be mistaken for another one.
 */
export function ChangeRequestsPage() {
  const { project, environments, loading: workspaceLoading } = useWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  const [items, setItems] = useState<ChangeRequest[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const loadedKey = useRef<string | null>(null)

  const statusParam = searchParams.get('status')
  const status: ChangeRequestStatus | null = isStatus(statusParam) ? statusParam : null
  const envKey = searchParams.get('env') ?? ''
  const flagKey = searchParams.get('flag') ?? ''

  const [flagDraft, setFlagDraft] = useState(flagKey)
  useEffect(() => setFlagDraft(flagKey), [flagKey])

  const setParam = useCallback(
    (key: string, value: string | null) => {
      setSearchParams(
        (prev) => {
          const params = new URLSearchParams(prev)
          if (!value) params.delete(key)
          else params.set(key, value)
          return params
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
        const res = await listChangeRequests(projectId, {
          status: status ?? undefined,
          envKey: envKey || undefined,
          flagKey: flagKey || undefined,
          limit: PAGE_SIZE,
        })
        setItems(res.items)
        setNextCursor(res.nextCursor)
      } catch (err) {
        setError(errorMessage(err, 'Could not load change requests'))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [status, envKey, flagKey],
  )

  useEffect(() => {
    if (!project) {
      if (!workspaceLoading) setLoading(false)
      return
    }
    const key = `${project.id}:${status ?? 'all'}:${envKey}:${flagKey}`
    const isFirstLoad = loadedKey.current === null || !loadedKey.current.startsWith(`${project.id}:`)
    if (isFirstLoad) setLoading(true)
    loadedKey.current = key
    void load(project.id, { refresh: !isFirstLoad })
  }, [project, workspaceLoading, status, envKey, flagKey, load])

  const loadMore = async () => {
    if (!project || !nextCursor) return
    setLoadingMore(true)
    try {
      const res = await listChangeRequests(project.id, {
        status: status ?? undefined,
        envKey: envKey || undefined,
        flagKey: flagKey || undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      })
      setItems((prev) => [...prev, ...res.items])
      setNextCursor(res.nextCursor)
    } catch (err) {
      setError(errorMessage(err, 'Could not load more change requests'))
    } finally {
      setLoadingMore(false)
    }
  }

  if (!workspaceLoading && !project) {
    return (
      <div className="space-y-6">
        <PageHeading title="Change requests" />
        <EmptyState
          icon={GitPullRequest}
          title="No project selected"
          description="Pick a project in the header to see the changes waiting for review."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeading
          title="Change requests"
          description="Writes to environments that require review. Nothing here has touched a flag — an approved request is applied the moment it meets its approval threshold."
        />
        <Button
          variant="outline"
          size="icon"
          aria-label="Refresh"
          data-testid="cr-refresh"
          disabled={!project || refreshing}
          onClick={() => project && void load(project.id, { refresh: true })}
        >
          <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
        </Button>
      </div>

      <Tabs value={status ?? 'all'} onValueChange={(v) => setParam('status', v === 'all' ? null : v)}>
        <TabsList>
          <TabsTrigger value="all" data-testid="cr-status-filter-all">
            All
          </TabsTrigger>
          {CHANGE_REQUEST_STATUSES.map((value) => (
            <TabsTrigger key={value} value={value} data-testid={`cr-status-filter-${value}`}>
              {value === 'PENDING' ? 'Awaiting review' : value.toLowerCase()}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      <div className="flex flex-wrap items-end gap-3">
        <div className="w-48 space-y-1.5">
          <Label htmlFor="cr-env-filter">Environment</Label>
          <Select
            value={envKey || ALL_ENVS}
            onValueChange={(v) => setParam('env', v === ALL_ENVS ? null : v)}
          >
            <SelectTrigger id="cr-env-filter" data-testid="cr-env-filter">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_ENVS}>All environments</SelectItem>
              {environments.map((env) => (
                <SelectItem key={env.id} value={env.key}>
                  {env.key}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <form
          className="w-64 space-y-1.5"
          onSubmit={(e) => {
            e.preventDefault()
            setParam('flag', flagDraft.trim() || null)
          }}
        >
          <Label htmlFor="cr-flag-filter">Flag key</Label>
          <Input
            id="cr-flag-filter"
            data-testid="cr-flag-filter"
            className="font-mono"
            placeholder="checkout-redesign"
            value={flagDraft}
            onChange={(e) => setFlagDraft(e.target.value)}
            onBlur={() => setParam('flag', flagDraft.trim() || null)}
          />
        </form>
        {(status || envKey || flagKey) && (
          <Button
            variant="ghost"
            data-testid="cr-clear-filters"
            onClick={() =>
              setSearchParams(new URLSearchParams(), { replace: true })
            }
          >
            Clear filters
          </Button>
        )}
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full" />
          ))}
        </div>
      ) : items.length === 0 ? (
        <EmptyState
          icon={GitPullRequest}
          title={status ? `Nothing ${status.toLowerCase()}` : 'No change requests'}
          description={
            status || envKey || flagKey
              ? 'Try another filter, or clear them to see everything in this project.'
              : 'A change request appears here when someone edits a flag in an environment that requires approval. No environment in this project requires one yet — turn it on in Settings → Approvals.'
          }
        />
      ) : (
        <ul className="space-y-2" data-testid="cr-list">
          {items.map((cr) => {
            const meta = cr.status
            return (
              <li key={cr.id}>
                <Link
                  to={`/change-requests/${cr.id}`}
                  data-testid={`cr-row-${cr.id}`}
                  className={cn(
                    'block rounded-md border p-4 transition-colors hover:bg-accent/50',
                    // STALE and DECLINED get a coloured left edge as well as a badge: a badge
                    // alone is easy to skim past in a long queue, and mistaking either for a
                    // pending request wastes a reviewer's time.
                    meta === 'STALE' && 'border-l-4 border-l-warning',
                    meta === 'DECLINED' && 'border-l-4 border-l-destructive',
                  )}
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-medium">{cr.flagKey}</span>
                    <EnvChip envKey={cr.envKey} />
                    <ChangeRequestKindBadge kind={cr.kind} />
                    <ChangeRequestStatusBadge status={cr.status} />
                    <span
                      className="ml-auto text-xs text-muted-foreground"
                      title={formatDateTime(cr.createdAt)}
                    >
                      {formatRelative(cr.createdAt)}
                    </span>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {cr.comment?.trim() || describeChangeRequestBriefly(cr)}
                  </p>
                  <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    <span data-testid={`cr-author-${cr.id}`}>
                      requested by <span className="font-mono">{cr.requestedBy}</span>
                    </span>
                    <ApprovalProgress changeRequest={cr} />
                    {cr.status === 'APPLIED' && cr.appliedVersion != null && (
                      <span>applied as v{cr.appliedVersion}</span>
                    )}
                  </div>
                </Link>
              </li>
            )
          })}
        </ul>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            data-testid="cr-load-more"
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
