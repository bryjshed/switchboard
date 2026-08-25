import { Link } from 'react-router-dom'
import { AlertTriangle, Check, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDateTime, formatRelative } from '@/lib/format'
import { formatRate } from '@/lib/rolloutStats'
import type { AnomalyFinding } from '@/types/api'

const SRM_EXPLANATION =
  'Traffic did not arrive in the proportions this rollout configured, so the variations are not ' +
  'comparable populations. Rate comparisons for this flag are suppressed until it is fixed.'

/** Small p-values matter here, so they do not collapse to 0.00. */
function formatPValue(pValue: number): string {
  if (pValue < 0.0001) {
    return '<0.0001'
  }
  return pValue.toFixed(4)
}

function pExplanation(finding: AnomalyFinding): string {
  const base =
    'Always-valid p-value: it stays correct however many times the monitor has looked since ' +
    'this rollout last changed its traffic allocation.'
  return finding.familySize && finding.familySize > 1
    ? `${base} Screened alongside ${finding.familySize} hypotheses, so the threshold was ` +
        `tightened accordingly.`
    : base
}

/**
 * Anomaly findings: what the monitor noticed, and what it did about it.
 *
 * An `AUTO_ROLLED_BACK` finding is not a to-do — the system already acted, and the row has
 * to say so before anything else, or an operator will start re-fixing a flag that is already
 * fixed. `OPEN` is the only state with an Acknowledge action; acknowledging an already-acked
 * finding is a 409 the caller handles.
 */
export function AnomalyList({
  findings,
  onAck,
  ackingId,
  flagLinkFor,
}: {
  findings: readonly AnomalyFinding[]
  onAck: (finding: AnomalyFinding) => void
  ackingId: string | null
  /** Where "Open flag" should go; lets the monitor page keep the environment selection. */
  flagLinkFor: (flagKey: string) => string
}) {
  return (
    <ul className="space-y-2" data-testid="anomaly-list">
      {findings.map((finding) => {
        const rolledBack = finding.status === 'AUTO_ROLLED_BACK'
        const acked = finding.status === 'ACKED'
        return (
          <li
            key={finding.id}
            data-testid={`anomaly-${finding.id}`}
            className={cn(
              'rounded-md border p-4',
              rolledBack && 'border-warning/50 bg-warning/5',
              acked && 'opacity-70',
            )}
          >
            <div className="flex flex-wrap items-center gap-2">
              {rolledBack ? (
                <ShieldCheck className="h-4 w-4 shrink-0 text-warning-foreground" aria-hidden />
              ) : (
                <AlertTriangle
                  className={cn(
                    'h-4 w-4 shrink-0',
                    acked ? 'text-muted-foreground' : 'text-destructive',
                  )}
                  aria-hidden
                />
              )}
              <Link
                to={flagLinkFor(finding.flagKey)}
                className="font-mono text-sm font-medium underline-offset-2 hover:underline"
              >
                {finding.flagKey}
              </Link>
              <Badge variant="outline" className="text-[10px]">
                {finding.metricKey}
              </Badge>
              {finding.kind === 'SRM' && (
                <Badge variant="warning" className="text-[10px]" title={SRM_EXPLANATION}>
                  allocation mismatch
                </Badge>
              )}
              {rolledBack ? (
                <Badge variant="warning" data-testid={`anomaly-status-${finding.id}`}>
                  rolled back automatically
                </Badge>
              ) : acked ? (
                <Badge variant="secondary" data-testid={`anomaly-status-${finding.id}`}>
                  acknowledged
                </Badge>
              ) : (
                <Badge variant="destructive" data-testid={`anomaly-status-${finding.id}`}>
                  open
                </Badge>
              )}
              <span
                className="ml-auto text-xs text-muted-foreground"
                title={formatDateTime(finding.createdAt)}
              >
                {formatRelative(finding.createdAt)}
              </span>
            </div>

            {rolledBack && (
              <p className="mt-2 text-sm font-medium text-warning-foreground">
                Switchboard already rolled this rollout back. No action is needed — read the
                summary to confirm it made the right call.
              </p>
            )}

            {finding.summary && <p className="mt-2 text-sm">{finding.summary}</p>}

            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-xs">
              <div>
                <dt className="inline text-muted-foreground">baseline </dt>
                <dd className="inline font-mono">{formatRate(finding.baselineRate)}</dd>
              </div>
              <div>
                <dt className="inline text-muted-foreground">variant </dt>
                <dd className="inline font-mono font-semibold text-destructive">
                  {formatRate(finding.variantRate)}
                </dd>
              </div>
              {/*
                The p-value leads, because it is what the decision was actually made on. It is
                always-valid: it accounts for the monitor having looked repeatedly since the
                rollout's allocation last changed, which a fixed-horizon p-value would not.
              */}
              {finding.pValue != null && (
                <div>
                  <dt className="inline text-muted-foreground">p </dt>
                  <dd className="inline font-mono" title={pExplanation(finding)}>
                    {formatPValue(finding.pValue)}
                  </dd>
                </div>
              )}
              {/* Descriptive only now, and absent on an allocation-mismatch finding. */}
              {finding.zScore != null && (
                <div>
                  <dt className="inline text-muted-foreground">z-score </dt>
                  <dd className="inline font-mono">{finding.zScore.toFixed(2)}</dd>
                </div>
              )}
              {finding.variantSubjects != null && (
                <div>
                  <dt className="inline text-muted-foreground">subjects </dt>
                  <dd className="inline font-mono" title="Distinct contexts, not evaluations">
                    {finding.variantSubjects.toLocaleString()}
                    {finding.baselineSubjects != null
                      ? ` vs ${finding.baselineSubjects.toLocaleString()}`
                      : ''}
                  </dd>
                </div>
              )}
            </dl>

            {finding.windowTruncated && (
              <p className="mt-2 text-xs text-muted-foreground">
                This rollout has run longer than the monitor looks back, so the evidence window
                was clipped and starts from a fixed point in time rather than from the last
                allocation change.
              </p>
            )}

            <div className="mt-3 flex flex-wrap items-center gap-2">
              {finding.status === 'OPEN' && (
                <Button
                  size="sm"
                  variant="outline"
                  data-testid={`anomaly-ack-${finding.id}`}
                  disabled={ackingId === finding.id}
                  onClick={() => onAck(finding)}
                >
                  <Check className="mr-1 h-3 w-3" />
                  {ackingId === finding.id ? 'Acknowledging…' : 'Acknowledge'}
                </Button>
              )}
              {finding.suggestedProposalId && (
                <Button size="sm" variant="secondary" asChild>
                  <Link
                    to={`/ai/proposals/${finding.suggestedProposalId}`}
                    data-testid={`anomaly-proposal-${finding.id}`}
                  >
                    Review proposal
                  </Link>
                </Button>
              )}
              <Button size="sm" variant="ghost" asChild>
                <Link to={flagLinkFor(finding.flagKey)} data-testid={`anomaly-flag-${finding.id}`}>
                  Open flag
                </Link>
              </Button>
            </div>
          </li>
        )
      })}
    </ul>
  )
}
