import { useMemo } from 'react'
import { ArrowRight, RotateCcw, Square } from 'lucide-react'
import { EnvChip } from '@/components/EnvChip'
import { Skeleton } from '@/components/ui/skeleton'
import { cn } from '@/lib/utils'
import { summarizeDiff } from '@/lib/diffSummary'
import type { ChangeLine, ChangeTone } from '@/lib/diffSummary'
import { ProposalKindBadge } from './proposalBadges'
import type { FlagChangeDiff, FlagDetail } from '@/types/api'

const TONE_CLASSES: Record<ChangeTone, string> = {
  neutral: 'border-border bg-muted/60 text-foreground',
  ok: 'border-ok/40 bg-ok/10 text-ok-foreground',
  warning: 'border-warning/40 bg-warning/10 text-warning-foreground',
  destructive: 'border-destructive/40 bg-destructive/10 text-destructive',
}

function ChangeValue({ children, tone }: { children: React.ReactNode; tone: ChangeTone }) {
  return (
    <span
      className={cn(
        'inline-block rounded border px-1.5 py-0.5 text-xs leading-relaxed',
        TONE_CLASSES[tone],
      )}
    >
      {children}
    </span>
  )
}

function ChangeRow({ line }: { line: ChangeLine }) {
  return (
    <div
      className="grid gap-1 py-1.5 sm:grid-cols-[8.5rem_1fr] sm:gap-3"
      data-testid={`diff-line-${line.key}`}
    >
      <dt className="pt-0.5 text-xs font-medium text-muted-foreground">{line.label}</dt>
      <dd className="flex flex-wrap items-center gap-1.5">
        {line.before !== undefined && (
          <>
            <ChangeValue tone="neutral">
              <span className="text-muted-foreground">{line.before}</span>
            </ChangeValue>
            <ArrowRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
          </>
        )}
        <ChangeValue tone={line.tone}>{line.after}</ChangeValue>
      </dd>
    </div>
  )
}

export interface DiffPreviewProps {
  diff: FlagChangeDiff
  /** The flag the diff edits, when it exists. Null means "before" values are unknowable. */
  flag: FlagDetail | null
  /** True while the flag is still being fetched, so the preview can say so rather than lie. */
  flagLoading?: boolean
  /**
   * Replaces the default `kind badge + flag key` line. Change requests carry their own kind
   * vocabulary (targeting update / kill switch / rollback) and would be mislabelled by the
   * proposal badge, so they pass their own header rather than forking the renderer.
   */
  heading?: React.ReactNode
  className?: string
}

/**
 * The reviewable rendering of a proposed change. Never raw JSON: a reviewer approving a
 * production rollout should be reading "Fallthrough 25% True / 75% False → 100% False", not
 * counting braces.
 *
 * Where the flag's current state is known, every line shows before → after. Where it is not
 * — a flag that does not exist yet, or a fetch that failed — lines render as pure additions
 * and the header says the before values are unavailable, because a missing "before" that
 * looks like "no change" is exactly the misreading that gets a bad rollout approved.
 */
export function DiffPreview({ diff, flag, flagLoading, heading, className }: DiffPreviewProps) {
  const summary = useMemo(() => summarizeDiff(diff, flag), [diff, flag])

  if (flagLoading) {
    return (
      <div className={cn('space-y-2', className)} data-testid="diff-preview-loading">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  return (
    <div className={cn('space-y-4', className)} data-testid="diff-preview">
      <div className="flex flex-wrap items-center gap-2">
        {heading ?? (
          <>
            <ProposalKindBadge kind={summary.kind} />
            <span className="font-mono text-sm font-medium">{summary.flagKey}</span>
          </>
        )}
        {!flag && summary.kind !== 'FLAG_CREATE' && (
          <span className="text-xs text-muted-foreground">
            current values unavailable — showing the proposed state only
          </span>
        )}
      </div>

      {summary.rollbackToVersion != null && (
        <p className="flex items-center gap-2 text-sm">
          <RotateCcw className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
          Restores the configuration from{' '}
          <span className="font-mono font-medium">v{summary.rollbackToVersion}</span> as a new
          version.
        </p>
      )}

      {summary.flagLines.length > 0 && (
        <section className="rounded-md border p-3" data-testid="diff-flag-section">
          <h4 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            The flag
          </h4>
          <dl className="divide-y divide-border/60">
            {summary.flagLines.map((line) => (
              <ChangeRow key={line.key} line={line} />
            ))}
          </dl>
        </section>
      )}

      {summary.envSections.map((section) => (
        <section
          key={section.envKey}
          className="rounded-md border p-3"
          data-testid={`diff-env-${section.envKey}`}
        >
          <h4 className="mb-1">
            <EnvChip envKey={section.envKey} />
          </h4>
          <dl className="divide-y divide-border/60">
            {section.lines.map((line) => (
              <ChangeRow key={line.key} line={line} />
            ))}
          </dl>
        </section>
      ))}

      {summary.retirementChecklist.length > 0 && (
        <section className="rounded-md border p-3" data-testid="diff-checklist">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
            Before this flag can go
          </h4>
          <ul className="space-y-1.5">
            {summary.retirementChecklist.map((step, i) => (
              <li key={i} className="flex items-start gap-2 text-sm">
                <Square className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span>{step}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      {summary.isEmpty && (
        <p className="text-sm text-muted-foreground" data-testid="diff-empty">
          This proposal would not change anything — the flag already matches what it asks for.
        </p>
      )}
    </div>
  )
}
