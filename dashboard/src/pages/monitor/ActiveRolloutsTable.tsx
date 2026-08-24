import { Link } from 'react-router-dom'
import { Badge } from '@/components/ui/badge'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { RolloutBar, SeriesDot } from '@/components/RolloutBar'
import { formatCount, formatRate, rolloutHealth } from '@/lib/rolloutStats'
import { buildSeriesMap } from '@/lib/variantSeries'
import { cn } from '@/lib/utils'
import type { FlagDetail, RolloutStats, Variation } from '@/types/api'

export interface RolloutRow {
  flag: FlagDetail
  envKey: string
  /** The fallthrough weights for this environment; always a rollout, that is why the row exists. */
  weights: { variationId: string; weight: number }[]
  /** Null when the stats call failed — the split still renders, the numbers say so. */
  stats: RolloutStats | null
}

function label(variations: readonly Variation[], variationId: string): string {
  const variation = variations.find((v) => v.id === variationId)
  return variation?.name?.trim() || variation?.value || 'unknown'
}

/**
 * Every flag in this environment currently splitting traffic, with how it is splitting and
 * how that is going. The leading variant's rates are the point: a split with no numbers next
 * to it tells you nothing about whether to ramp it or roll it back.
 */
export function ActiveRolloutsTable({
  rows,
  monitorLinkFor,
}: {
  rows: readonly RolloutRow[]
  monitorLinkFor: (flagKey: string) => string
}) {
  return (
    <div className="rounded-md border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Flag</TableHead>
            <TableHead className="w-[26%]">Split</TableHead>
            <TableHead className="text-right">Evals</TableHead>
            <TableHead>Leading variant</TableHead>
            <TableHead className="w-24" />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map(({ flag, weights, stats }) => {
            const seriesMap = buildSeriesMap(flag.variations.map((v) => v.id))
            const totals = stats?.totals ?? []
            const health = rolloutHealth(totals)
            const leadId = health.conversionLeaderId ?? health.trafficLeaderId
            const lead = totals.find((v) => v.variationId === leadId)
            const leadFlagged = leadId != null && health.errorFlagged.has(leadId)

            return (
              <TableRow key={flag.id} data-testid={`rollout-row-${flag.key}`}>
                <TableCell>
                  <div className="font-mono text-sm">{flag.key}</div>
                  <div className="text-xs text-muted-foreground">{flag.name}</div>
                </TableCell>
                <TableCell>
                  <RolloutBar
                    segments={weights.map((w) => ({
                      variationId: w.variationId,
                      weight: w.weight,
                      series: seriesMap.get(w.variationId) ?? 0,
                      label: label(flag.variations, w.variationId),
                    }))}
                  />
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                    {weights.map((w) => (
                      <span
                        key={w.variationId}
                        className="inline-flex items-center gap-1.5 text-xs text-muted-foreground"
                      >
                        <SeriesDot series={seriesMap.get(w.variationId) ?? 0} />
                        {w.weight}% {label(flag.variations, w.variationId)}
                      </span>
                    ))}
                  </div>
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {stats ? formatCount(health.totalEvals) : '—'}
                </TableCell>
                <TableCell>
                  {!stats ? (
                    <span className="text-xs text-muted-foreground">stats unavailable</span>
                  ) : !lead ? (
                    <span className="text-xs text-muted-foreground">
                      not enough traffic to call one
                    </span>
                  ) : (
                    <div className="space-y-0.5">
                      <div className="flex items-center gap-1.5 text-sm">
                        <SeriesDot series={seriesMap.get(lead.variationId) ?? 0} />
                        <span>{lead.variationName ?? label(flag.variations, lead.variationId)}</span>
                        {health.conversionLeaderId === lead.variationId && (
                          <Badge variant="ok" className="text-[10px]">
                            leading
                          </Badge>
                        )}
                      </div>
                      <div className="flex gap-3 text-xs text-muted-foreground">
                        <span
                          className={cn(
                            'font-mono',
                            leadFlagged && 'font-semibold text-destructive',
                          )}
                        >
                          err {formatRate(lead.errorRate)}
                        </span>
                        <span className="font-mono">conv {formatRate(lead.conversionRate)}</span>
                      </div>
                    </div>
                  )}
                </TableCell>
                <TableCell className="text-right">
                  <Link
                    to={monitorLinkFor(flag.key)}
                    data-testid={`rollout-detail-${flag.key}`}
                    className="text-sm underline underline-offset-2 hover:text-foreground"
                  >
                    Details
                  </Link>
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
