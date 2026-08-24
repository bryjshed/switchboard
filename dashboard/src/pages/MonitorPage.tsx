import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Activity, RefreshCw, Sparkles } from 'lucide-react'
import { PageHeading } from '@/components/layout/PageHeading'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Badge } from '@/components/ui/badge'
import { EmptyState } from '@/components/EmptyState'
import { EnvChip } from '@/components/EnvChip'
import { AnomalyList } from './monitor/AnomalyList'
import { ActiveRolloutsTable } from './monitor/ActiveRolloutsTable'
import type { RolloutRow } from './monitor/ActiveRolloutsTable'
import { ProposalKindBadge, ProposalStatusBadge } from './ai/proposalBadges'
import { listAnomalies, ackAnomaly, getRolloutStats } from '@/lib/monitorApi'
import { listProposals } from '@/lib/aiApi'
import { getFlag, listFlags } from '@/lib/flagsApi'
import { ConflictError, errorMessage } from '@/lib/apiClient'
import { formatDateTime, formatRelative } from '@/lib/format'
import { MONITOR_WINDOWS, parseWindowHours } from '@/lib/rolloutStats'
import { useToast } from '@/components/ui/use-toast'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { AiProposal, AnomalyFinding } from '@/types/api'

/**
 * How many rollouts we will pull detail + stats for. A project with fifty simultaneous
 * rollouts is a different screen; fetching all of them here would be a request storm for a
 * table nobody can read anyway.
 */
const MAX_ROLLOUT_ROWS = 12

const RECENT_PROPOSALS = 5

interface MonitorData {
  findings: AnomalyFinding[]
  rollouts: RolloutRow[]
  proposals: AiProposal[]
}

const EMPTY: MonitorData = { findings: [], rollouts: [], proposals: [] }

export function MonitorPage() {
  const { toast } = useToast()
  const { project, environment, loading: workspaceLoading } = useWorkspace()
  const [searchParams, setSearchParams] = useSearchParams()

  const [data, setData] = useState<MonitorData>(EMPTY)
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [ackingId, setAckingId] = useState<string | null>(null)
  const loadedKey = useRef<string | null>(null)

  const hours = parseWindowHours(searchParams.get('hours'))

  const setHours = (next: number) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('hours', String(next))
        return params
      },
      { replace: true },
    )

  const load = useCallback(
    async (projectId: string, envId: string, envKey: string, opts: { refresh?: boolean } = {}) => {
      if (opts.refresh) setRefreshing(true)
      setError(null)
      try {
        const [findings, flagList, proposalList] = await Promise.all([
          listAnomalies(envId),
          listFlags(projectId),
          listProposals(projectId, { limit: RECENT_PROPOSALS }),
        ])

        // `rolloutPercentage` on the summary is the cheap signal that a flag's fallthrough is
        // a rollout; the detail call is only made for the handful that qualify. A killed or
        // switched-off flag is excluded even when its config still holds a split — it is
        // serving the off variation to everyone, so it is not splitting anything.
        const rolloutKeys = flagList.items
          .filter((flag) => {
            const summary = flag.environments.find((e) => e.envKey === envKey)
            return (
              summary != null &&
              summary.rolloutPercentage != null &&
              summary.enabled &&
              !summary.killSwitchActive
            )
          })
          .slice(0, MAX_ROLLOUT_ROWS)
          .map((flag) => flag.key)

        const rollouts = await Promise.all(
          rolloutKeys.map(async (flagKey): Promise<RolloutRow | null> => {
            const [flag, stats] = await Promise.all([
              getFlag(projectId, flagKey).catch(() => null),
              getRolloutStats(envId, flagKey, hours).catch(() => null),
            ])
            if (!flag) return null
            const config = flag.envConfigs.find((c) => c.envKey === envKey)
            const weights = config?.config.fallthrough.rollout ?? []
            if (weights.length === 0) return null
            return { flag, envKey, weights, stats }
          }),
        )

        setData({
          findings,
          rollouts: rollouts.filter((row): row is RolloutRow => row !== null),
          proposals: proposalList.items,
        })
      } catch (err) {
        setError(errorMessage(err, 'Could not load monitoring data'))
      } finally {
        setLoading(false)
        setRefreshing(false)
      }
    },
    [hours],
  )

  useEffect(() => {
    if (!project || !environment) {
      if (!workspaceLoading) setLoading(false)
      return
    }
    const key = `${project.id}:${environment.id}`
    const isFirstLoad = loadedKey.current !== key
    if (isFirstLoad) setLoading(true)
    loadedKey.current = key
    void load(project.id, environment.id, environment.key, { refresh: !isFirstLoad })
  }, [project, environment, workspaceLoading, hours, load])

  const refresh = () => {
    if (project && environment) {
      void load(project.id, environment.id, environment.key, { refresh: true })
    }
  }

  const handleAck = async (finding: AnomalyFinding) => {
    setAckingId(finding.id)
    try {
      const updated = await ackAnomaly(finding.id)
      setData((prev) => ({
        ...prev,
        findings: prev.findings.map((f) => (f.id === updated.id ? updated : f)),
      }))
      toast({ title: 'Acknowledged', description: `${finding.flagKey} — ${finding.metricKey}` })
    } catch (err) {
      if (err instanceof ConflictError) {
        toast({
          variant: 'destructive',
          title: 'Already handled',
          description: 'This finding is no longer open. Reloading.',
        })
        refresh()
      } else {
        toast({ variant: 'destructive', title: 'Could not acknowledge', description: errorMessage(err) })
      }
    } finally {
      setAckingId(null)
    }
  }

  if (!workspaceLoading && (!project || !environment)) {
    return (
      <div className="space-y-6">
        <PageHeading title="Monitor" />
        <EmptyState
          icon={Activity}
          title="No environment selected"
          description="Pick a project and environment in the header to see what its rollouts are doing."
        />
      </div>
    )
  }

  const flagLinkFor = (flagKey: string) => `/flags/${encodeURIComponent(flagKey)}`
  const monitorLinkFor = (flagKey: string) =>
    `/flags/${encodeURIComponent(flagKey)}?tab=monitor&hours=${hours}`

  // The section exists whenever there is anything to show and vanishes entirely when there
  // is not — an empty state shouting "no anomalies!" at you every day is how people learn to
  // stop reading a screen. Acknowledged findings stay visible for context but they are
  // dimmed, and they change the heading from "needs a look" to "recently flagged" so a
  // handled queue never reads as an open one.
  const openCount = data.findings.filter((f) => f.status === 'OPEN').length
  const actionable = data.findings.filter(
    (f) => f.status === 'OPEN' || f.status === 'AUTO_ROLLED_BACK',
  ).length

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeading
          title="Monitor"
          description={
            environment
              ? 'What the AI layer is watching right now: rollouts in flight, anything it has flagged, and anything it has already done about it.'
              : undefined
          }
        />
        <div className="flex items-center gap-2">
          {environment && <EnvChip envKey={environment.key} />}
          <div className="flex rounded-md border p-0.5" role="group" aria-label="Time window">
            {MONITOR_WINDOWS.map((window) => (
              <button
                key={window.hours}
                type="button"
                data-testid={`monitor-window-${window.hours}`}
                aria-pressed={hours === window.hours}
                onClick={() => setHours(window.hours)}
                className={
                  hours === window.hours
                    ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
                    : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                }
              >
                {window.label}
              </button>
            ))}
          </div>
          <Button
            variant="outline"
            size="icon"
            aria-label="Refresh"
            data-testid="monitor-refresh"
            disabled={refreshing || !project}
            onClick={refresh}
          >
            <RefreshCw className={refreshing ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} />
          </Button>
        </div>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-28 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : (
        <>
          {data.findings.length > 0 && (
            <section className="space-y-3" data-testid="monitor-anomalies">
              <div className="flex items-center gap-2">
                <h3 className="text-sm font-semibold">
                  {actionable > 0 ? 'Needs a look' : 'Recently flagged'}
                </h3>
                {openCount > 0 ? (
                  <Badge variant="destructive" className="text-[10px]">
                    {openCount} open
                  </Badge>
                ) : (
                  <Badge variant="secondary" className="text-[10px]">
                    all handled
                  </Badge>
                )}
              </div>
              <AnomalyList
                findings={data.findings}
                onAck={(finding) => void handleAck(finding)}
                ackingId={ackingId}
                flagLinkFor={flagLinkFor}
              />
            </section>
          )}

          <section className="space-y-3" data-testid="monitor-rollouts">
            <h3 className="text-sm font-semibold">
              Active rollouts{' '}
              <span className="font-normal text-muted-foreground">
                · last {MONITOR_WINDOWS.find((w) => w.hours === hours)?.label}
              </span>
            </h3>
            {data.rollouts.length === 0 ? (
              <EmptyState
                icon={Activity}
                title="Nothing is splitting traffic here"
                description={`No flag in ${environment?.key ?? 'this environment'} is serving a percentage rollout, so there is nothing to compare yet.`}
              />
            ) : (
              <ActiveRolloutsTable rows={data.rollouts} monitorLinkFor={monitorLinkFor} />
            )}
          </section>

          <section className="space-y-3" data-testid="monitor-activity">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Recent AI activity</h3>
              <Link
                to="/ai/proposals"
                data-testid="monitor-all-proposals"
                className="text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                All proposals
              </Link>
            </div>
            {data.proposals.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                Nothing yet. The monitor raises a proposal when a rollout starts misbehaving.
              </p>
            ) : (
              <ul className="divide-y rounded-md border">
                {data.proposals.map((proposal) => (
                  <li key={proposal.id}>
                    <Link
                      to={`/ai/proposals/${proposal.id}`}
                      data-testid={`monitor-proposal-${proposal.id}`}
                      className="flex flex-wrap items-center gap-2 p-3 transition-colors hover:bg-accent/50"
                    >
                      <Sparkles className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      <ProposalKindBadge kind={proposal.kind} />
                      <ProposalStatusBadge status={proposal.status} />
                      <span className="font-mono text-sm">{proposal.diff.flagKey}</span>
                      <span
                        className="ml-auto text-xs text-muted-foreground"
                        title={formatDateTime(proposal.createdAt)}
                      >
                        {formatRelative(proposal.createdAt)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  )
}
