import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { Activity, RotateCcw } from 'lucide-react'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { EmptyState } from '@/components/EmptyState'
import { RateBar } from '@/components/RateBar'
import { RolloutBar, SeriesDot } from '@/components/RolloutBar'
import { VariantSeriesChart } from '@/components/VariantSeriesChart'
import { AnomalyList } from '@/pages/monitor/AnomalyList'
import { ackAnomaly, getRolloutStats, listAnomalies } from '@/lib/monitorApi'
import { rollbackFlagEnvConfig } from '@/lib/flagsApi'
import { ConflictError, errorMessage } from '@/lib/apiClient'
import { queuedWriteToast } from '@/lib/changeRequestDisplay'
import { QueuedForReviewNotice } from '@/components/QueuedForReviewNotice'
import { usePermissionGate } from '@/hooks/usePermissions'
import {
  MONITOR_WINDOWS,
  buildTimeSeries,
  formatCount,
  formatRate,
  niceCeiling,
  parseWindowHours,
  rolloutHealth,
} from '@/lib/rolloutStats'
import type { RateMetric } from '@/lib/rolloutStats'
import { buildSeriesMap } from '@/lib/variantSeries'
import { cn } from '@/lib/utils'
import { variationLabel } from './variationLabel'
import type {
  AnomalyFinding,
  ApprovalSettings,
  ChangeRequest,
  FlagDetail,
  FlagEnvConfig,
  RolloutStats,
} from '@/types/api'

const METRICS: { value: RateMetric | 'evalCount'; label: string }[] = [
  { value: 'errorRate', label: 'Error rate' },
  { value: 'conversionRate', label: 'Conversion rate' },
  { value: 'evalCount', label: 'Evaluations' },
]

export interface MonitorTabProps {
  projectId: string
  flag: FlagDetail
  config: FlagEnvConfig
  /** This environment's approval policy: a gated rollback opens a review, not a version. */
  approvals?: ApprovalSettings
  onRolledBack: (config: FlagEnvConfig) => void
}

/**
 * One flag's rollout, in one environment: who is getting what, how each variation is doing,
 * and how that has moved over the window.
 *
 * Everything a variation is coloured with comes from one `buildSeriesMap` over the flag's own
 * variation order, so the split bar, the table dots, the rate bars and the chart lines all
 * agree — a reviewer should never have to re-learn which colour is which halfway down.
 */
export function MonitorTab({
  projectId,
  flag,
  config,
  approvals,
  onRolledBack,
}: MonitorTabProps) {
  const { toast } = useToast()
  const rollbackGate = usePermissionGate('FLAG_ROLLBACK')
  const [searchParams, setSearchParams] = useSearchParams()

  const [stats, setStats] = useState<RolloutStats | null>(null)
  const [findings, setFindings] = useState<AnomalyFinding[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [ackingId, setAckingId] = useState<string | null>(null)
  const [metric, setMetric] = useState<RateMetric | 'evalCount'>('errorRate')
  const [rollbackOpen, setRollbackOpen] = useState(false)
  const [reason, setReason] = useState('')
  const [rollingBack, setRollingBack] = useState(false)
  const [queued, setQueued] = useState<ChangeRequest | null>(null)

  const gated = approvals?.requireApproval === true

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

  const load = useCallback(async () => {
    setError(null)
    try {
      const [nextStats, nextFindings] = await Promise.all([
        getRolloutStats(config.environmentId, flag.key, hours),
        listAnomalies(config.environmentId).catch(() => [] as AnomalyFinding[]),
      ])
      setStats(nextStats)
      setFindings(nextFindings.filter((f) => f.flagKey === flag.key))
    } catch (err) {
      setError(errorMessage(err, 'Could not load rollout stats'))
    } finally {
      setLoading(false)
    }
  }, [config.environmentId, flag.key, hours])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const seriesMap = useMemo(
    () => buildSeriesMap(flag.variations.map((v) => v.id)),
    [flag.variations],
  )
  const totals = useMemo(() => stats?.totals ?? [], [stats])
  const health = useMemo(() => rolloutHealth(totals), [totals])
  const timeSeries = useMemo(
    () => buildTimeSeries(stats?.buckets ?? [], metric),
    [stats, metric],
  )

  // One ceiling per rate column so the bars are comparable down the column, which is the
  // only reason to draw them at all.
  const errorMax = niceCeiling(Math.max(0, ...totals.map((v) => v.errorRate)), 0.05)
  const conversionMax = niceCeiling(Math.max(0, ...totals.map((v) => v.conversionRate)), 0.05)

  const weights = config.config.fallthrough.rollout ?? []
  const suggested = findings.find((f) => f.suggestedProposalId)?.suggestedProposalId

  const handleAck = async (finding: AnomalyFinding) => {
    setAckingId(finding.id)
    try {
      const updated = await ackAnomaly(finding.id)
      setFindings((prev) => prev.map((f) => (f.id === updated.id ? updated : f)))
      toast({ title: 'Acknowledged', description: `${finding.flagKey} — ${finding.metricKey}` })
    } catch (err) {
      if (err instanceof ConflictError) {
        toast({
          variant: 'destructive',
          title: 'Already handled',
          description: 'This finding is no longer open. Reloading.',
        })
        void load()
      } else {
        toast({ variant: 'destructive', title: 'Could not acknowledge', description: errorMessage(err) })
      }
    } finally {
      setAckingId(null)
    }
  }

  const handleRollback = async () => {
    setRollingBack(true)
    setQueued(null)
    try {
      const result = await rollbackFlagEnvConfig(projectId, flag.key, config.envKey, {
        toVersion: config.version - 1,
        reason: reason.trim() || undefined,
      })
      if (result.outcome === 'queued') {
        setQueued(result.changeRequest)
        toast(queuedWriteToast(result.changeRequest))
      } else {
        onRolledBack(result.config)
        toast({
          title: `Rolled back to v${config.version - 1}`,
          description: `Written as new version ${result.config.version}. Nothing in the history was changed.`,
        })
      }
      setRollbackOpen(false)
      setReason('')
      await load()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Rollback failed', description: errorMessage(err) })
    } finally {
      setRollingBack(false)
    }
  }

  const formatValue = (value: number) =>
    metric === 'evalCount' ? formatCount(Math.round(value)) : formatRate(value, 0)

  return (
    <div className="space-y-6">
      {queued && <QueuedForReviewNotice changeRequest={queued} />}

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex rounded-md border p-0.5" role="group" aria-label="Time window">
          {MONITOR_WINDOWS.map((window) => (
            <button
              key={window.hours}
              type="button"
              data-testid={`flag-monitor-window-${window.hours}`}
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
        <div className="flex flex-wrap items-center gap-2">
          {suggested && (
            <Button variant="secondary" size="sm" asChild>
              <Link to={`/ai/proposals/${suggested}`} data-testid="flag-monitor-proposal">
                Review proposal
              </Link>
            </Button>
          )}
          <Button
            variant="outline"
            size="sm"
            data-testid="flag-monitor-rollback"
            disabled={config.version <= 1 || !rollbackGate.allowed}
            title={
              !rollbackGate.allowed
                ? rollbackGate.reason
                : config.version <= 1
                  ? 'There is no earlier version to roll back to'
                  : `Restore v${config.version - 1}`
            }
            onClick={() => setRollbackOpen(true)}
          >
            <RotateCcw className="mr-1 h-3 w-3" />{' '}
            {gated ? 'Request a rollback' : 'Roll back now'}
          </Button>
        </div>
      </div>

      {weights.length > 0 && (
        <div className="space-y-1.5">
          <RolloutBar
            segments={weights.map((w) => ({
              variationId: w.variationId,
              weight: w.weight,
              series: seriesMap.get(w.variationId) ?? 0,
              label: variationLabel(flag.variations.find((v) => v.id === w.variationId)),
            }))}
          />
          <p className="text-xs text-muted-foreground">
            Current split in <span className="font-mono">{config.envKey}</span>:{' '}
            {weights
              .map(
                (w) =>
                  `${w.weight}% ${variationLabel(flag.variations.find((v) => v.id === w.variationId))}`,
              )
              .join(' · ')}
          </p>
        </div>
      )}

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-40 w-full" />
          <Skeleton className="h-48 w-full" />
        </div>
      ) : totals.length === 0 ? (
        <EmptyState
          icon={Activity}
          title="No evaluations in this window"
          description="Nothing has asked Switchboard for this flag recently, so there is nothing to compare. Try a longer window."
        />
      ) : (
        <>
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Variation</TableHead>
                  <TableHead className="text-right">Evals</TableHead>
                  <TableHead className="w-[22%]">Error rate</TableHead>
                  <TableHead className="w-[22%]">Conversion rate</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {totals.map((variant) => {
                  const variation = flag.variations.find((v) => v.id === variant.variationId)
                  const slot = seriesMap.get(variant.variationId) ?? 0
                  const flagged = health.errorFlagged.has(variant.variationId)
                  const leading = health.conversionLeaderId === variant.variationId
                  return (
                    <TableRow
                      key={variant.variationId}
                      data-testid={`variant-row-${variant.variationId}`}
                      className={cn(flagged && 'bg-destructive/5')}
                    >
                      <TableCell>
                        <div className="flex items-center gap-2">
                          <SeriesDot series={slot} />
                          <span className="text-sm">
                            {variant.variationName ?? variationLabel(variation)}
                          </span>
                          {leading && (
                            <Badge variant="ok" className="text-[10px]" data-testid="variant-leading">
                              leading
                            </Badge>
                          )}
                        </div>
                        {variation && (
                          <div className="mt-0.5 pl-4 font-mono text-xs text-muted-foreground">
                            {variation.value}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right font-mono text-sm">
                        {formatCount(variant.evalCount)}
                      </TableCell>
                      <TableCell>
                        <div
                          className={cn(
                            'mb-1 font-mono text-sm',
                            flagged && 'font-semibold text-destructive',
                          )}
                        >
                          {formatRate(variant.errorRate)}
                          {flagged && (
                            <Badge
                              variant="destructive"
                              className="ml-1.5 text-[10px]"
                              data-testid="variant-erroring"
                            >
                              erroring
                            </Badge>
                          )}
                        </div>
                        <RateBar
                          value={variant.errorRate}
                          max={errorMax}
                          series={slot}
                          tone={flagged ? 'destructive' : 'muted'}
                        />
                      </TableCell>
                      <TableCell>
                        <div className="mb-1 font-mono text-sm">
                          {formatRate(variant.conversionRate)}
                        </div>
                        <RateBar value={variant.conversionRate} max={conversionMax} series={slot} />
                      </TableCell>
                    </TableRow>
                  )
                })}
              </TableBody>
            </Table>
          </div>

          <section className="space-y-2 rounded-md border p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="text-sm font-semibold">Over time</h3>
              <div className="flex rounded-md border p-0.5" role="group" aria-label="Metric">
                {METRICS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    data-testid={`flag-monitor-metric-${option.value}`}
                    aria-pressed={metric === option.value}
                    onClick={() => setMetric(option.value)}
                    className={
                      metric === option.value
                        ? 'rounded px-2.5 py-1 text-xs font-medium bg-primary text-primary-foreground'
                        : 'rounded px-2.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground'
                    }
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>
            <VariantSeriesChart
              data={timeSeries}
              seriesMap={seriesMap}
              formatValue={formatValue}
              metricLabel={METRICS.find((m) => m.value === metric)?.label ?? metric}
              className="h-48 w-full"
            />
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {timeSeries.series.map((variant) => (
                <span
                  key={variant.variationId}
                  className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                >
                  <SeriesDot series={seriesMap.get(variant.variationId) ?? 0} />
                  {variant.variationName ??
                    variationLabel(flag.variations.find((v) => v.id === variant.variationId))}
                </span>
              ))}
            </div>
            <p className="text-xs text-muted-foreground">
              A gap means that variation served no traffic in that hour — not a rate of zero.
            </p>
          </section>
        </>
      )}

      {findings.length > 0 && (
        <section className="space-y-2" data-testid="flag-monitor-findings">
          <h3 className="text-sm font-semibold">Findings for this flag</h3>
          <AnomalyList
            findings={findings}
            onAck={(finding) => void handleAck(finding)}
            ackingId={ackingId}
            flagLinkFor={(key) => `/flags/${encodeURIComponent(key)}`}
          />
        </section>
      )}

      <AlertDialog
        open={rollbackOpen}
        onOpenChange={(open) => {
          if (!open) {
            setRollbackOpen(false)
            setReason('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gated ? 'Request a rollback to v' : 'Roll back to v'}
              {config.version - 1}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {gated ? (
                <>
                  {config.envKey} requires approval, so this opens a change request and the
                  rollout keeps running until a reviewer approves it. If this is an incident,
                  the kill switch is the faster instrument.
                </>
              ) : (
                <>
                  Switchboard copies the v{config.version - 1} snapshot into a{' '}
                  <strong>new version</strong> (v{config.version + 1}) and starts serving it.
                  Nothing in the history is erased. To restore a different version, use the
                  History tab.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="monitor-rollback-reason">Reason</Label>
            <Input
              id="monitor-rollback-reason"
              data-testid="monitor-rollback-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Error rate on the new variation"
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={rollingBack}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="monitor-rollback-confirm"
              disabled={rollingBack}
              onClick={(e) => {
                e.preventDefault()
                void handleRollback()
              }}
            >
              {rollingBack
                ? gated
                  ? 'Submitting…'
                  : 'Rolling back…'
                : gated
                  ? 'Submit for review'
                  : `Create v${config.version + 1} from this`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
