import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { RefreshCw, Sparkles } from 'lucide-react'
import { PageHeading } from '@/components/layout/PageHeading'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { EmptyState } from '@/components/EmptyState'
import { listProposals } from '@/lib/aiApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime, formatRelative } from '@/lib/format'
import { PROPOSAL_STATUSES } from '@/types/api'
import type { AiProposal, ProposalStatus } from '@/types/api'
import { ProposalAuthor, ProposalKindBadge, ProposalStatusBadge } from './proposalBadges'
import { AskAiDialog } from './AskAiDialog'
import { useWorkspace } from '@/hooks/useWorkspace'

const PAGE_SIZE = 25

function isStatus(value: string | null): value is ProposalStatus {
  return value !== null && (PROPOSAL_STATUSES as readonly string[]).includes(value)
}

export function ProposalsPage() {
  const navigate = useNavigate()
  const { project, loading: workspaceLoading } = useWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  const [proposals, setProposals] = useState<AiProposal[]>([])
  const [nextCursor, setNextCursor] = useState<string | undefined>()
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [askOpen, setAskOpen] = useState(false)
  const loadedKey = useRef<string | null>(null)

  // The status filter drives the API query, so it belongs in the URL alongside the other
  // list filters (see FlagsPage `?q=` / `?tag=`): a link to the DRAFT queue is a real thing
  // to send someone at 3am.
  const statusParam = searchParams.get('status')
  const status: ProposalStatus | null = isStatus(statusParam) ? statusParam : null

  const setStatus = (next: string) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        if (next === 'all') params.delete('status')
        else params.set('status', next)
        return params
      },
      { replace: true },
    )
  }

  const load = useCallback(
    async (projectId: string, opts: { refresh?: boolean } = {}) => {
      if (opts.refresh) setRefreshing(true)
      setError(null)
      try {
        const res = await listProposals(projectId, {
          status: status ?? undefined,
          limit: PAGE_SIZE,
        })
        setProposals(res.items)
        setNextCursor(res.nextCursor)
      } catch (err) {
        setError(errorMessage(err, 'Could not load proposals'))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [status],
  )

  useEffect(() => {
    if (!project) {
      if (!workspaceLoading) setLoading(false)
      return
    }
    const key = `${project.id}:${status ?? 'all'}`
    const isFirstLoad = loadedKey.current === null || !loadedKey.current.startsWith(`${project.id}:`)
    if (isFirstLoad) setLoading(true)
    loadedKey.current = key
    void load(project.id, { refresh: !isFirstLoad })
  }, [project, workspaceLoading, status, load])

  const loadMore = async () => {
    if (!project || !nextCursor) return
    setLoadingMore(true)
    try {
      const res = await listProposals(project.id, {
        status: status ?? undefined,
        cursor: nextCursor,
        limit: PAGE_SIZE,
      })
      setProposals((prev) => [...prev, ...res.items])
      setNextCursor(res.nextCursor)
    } catch (err) {
      setError(errorMessage(err, 'Could not load more proposals'))
    } finally {
      setLoadingMore(false)
    }
  }

  if (!workspaceLoading && !project) {
    return (
      <div className="space-y-6">
        <PageHeading title="AI proposals" />
        <EmptyState
          icon={Sparkles}
          title="No project selected"
          description="Pick a project in the header to see the proposals raised for it."
        />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeading
          title="AI proposals"
          description="Every change the AI layer has drafted — the ones it raised itself after watching a rollout, and the ones you asked for. Nothing here has been applied unless it says so."
        />
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh"
            data-testid="proposals-refresh"
            disabled={!project || refreshing}
            onClick={() => project && void load(project.id, { refresh: true })}
          >
            <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
          <Button data-testid="proposals-ask-ai" disabled={!project} onClick={() => setAskOpen(true)}>
            <Sparkles className="mr-1 h-4 w-4" /> Ask AI
          </Button>
        </div>
      </div>

      <Tabs value={status ?? 'all'} onValueChange={setStatus}>
        <TabsList>
          <TabsTrigger value="all" data-testid="proposals-status-all">
            All
          </TabsTrigger>
          {PROPOSAL_STATUSES.map((value) => (
            <TabsTrigger key={value} value={value} data-testid={`proposals-status-${value}`}>
              {value === 'DRAFT' ? 'Awaiting review' : value.toLowerCase()}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-24 w-full" />
          ))}
        </div>
      ) : proposals.length === 0 ? (
        <EmptyState
          icon={Sparkles}
          title={status ? `No ${status.toLowerCase()} proposals` : 'No proposals yet'}
          description={
            status
              ? 'Try another status, or clear the filter to see everything.'
              : 'The monitor raises one when a rollout starts misbehaving. You can also describe a change in plain English and review what it drafts.'
          }
          action={
            !status && (
              <Button onClick={() => setAskOpen(true)}>
                <Sparkles className="mr-1 h-4 w-4" /> Ask AI
              </Button>
            )
          }
        />
      ) : (
        <ul className="space-y-2" data-testid="proposals-list">
          {proposals.map((proposal) => (
            <li key={proposal.id}>
              <Link
                to={`/ai/proposals/${proposal.id}`}
                data-testid={`proposal-row-${proposal.id}`}
                className="block rounded-md border p-4 transition-colors hover:bg-accent/50"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <ProposalKindBadge kind={proposal.kind} />
                  <ProposalStatusBadge status={proposal.status} />
                  <span className="font-mono text-sm font-medium">{proposal.diff.flagKey}</span>
                  <span
                    className="ml-auto text-xs text-muted-foreground"
                    title={formatDateTime(proposal.createdAt)}
                  >
                    {formatRelative(proposal.createdAt)}
                  </span>
                </div>
                {proposal.rationale && (
                  <p className="mt-2 line-clamp-2 text-sm text-muted-foreground">
                    {proposal.rationale}
                  </p>
                )}
                <div className="mt-2">
                  <ProposalAuthor createdBy={proposal.createdBy} />
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {nextCursor && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            data-testid="proposals-load-more"
            disabled={loadingMore}
            onClick={() => void loadMore()}
          >
            {loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}

      {project && (
        <AskAiDialog
          projectId={project.id}
          open={askOpen}
          onOpenChange={setAskOpen}
          onApplied={(proposal) => navigate(`/ai/proposals/${proposal.id}`)}
        />
      )}
    </div>
  )
}
