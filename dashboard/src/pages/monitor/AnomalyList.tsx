import { Link } from 'react-router-dom'
import { AlertTriangle, Check, ShieldCheck } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { formatDateTime, formatRelative } from '@/lib/format'
import { formatRate } from '@/lib/rolloutStats'
import type { AnomalyFinding } from '@/types/api'

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
              <div>
                <dt className="inline text-muted-foreground">z-score </dt>
                <dd className="inline font-mono">{finding.zScore.toFixed(2)}</dd>
              </div>
            </dl>

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
