import { Bot, User } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { KIND_LABELS } from '@/lib/diffSummary'
import { isSystemAuthor } from '@/types/api'
import type { ProposalKind, ProposalStatus } from '@/types/api'

const STATUS_VARIANT: Record<ProposalStatus, 'info' | 'ok' | 'secondary' | 'outline'> = {
  DRAFT: 'info',
  APPLIED: 'ok',
  REJECTED: 'secondary',
  EXPIRED: 'outline',
}

const STATUS_LABEL: Record<ProposalStatus, string> = {
  DRAFT: 'awaiting review',
  APPLIED: 'applied',
  REJECTED: 'rejected',
  EXPIRED: 'expired',
}

export function ProposalStatusBadge({ status }: { status: ProposalStatus }) {
  return (
    <Badge variant={STATUS_VARIANT[status]} data-testid={`proposal-status-${status}`}>
      {STATUS_LABEL[status]}
    </Badge>
  )
}

export function ProposalKindBadge({ kind }: { kind: ProposalKind }) {
  // Retirement and rollback are the two kinds that take something away, so they carry the
  // warning tint; creating and updating are ordinary.
  const variant = kind === 'ROLLBACK' || kind === 'RETIREMENT' ? 'warning' : 'outline'
  return <Badge variant={variant}>{KIND_LABELS[kind]}</Badge>
}

/**
 * Who raised this. A proposal from `switchboard-monitor` or `switchboard-sweeper` was
 * written by the system with no human in the loop, and saying so plainly is the difference
 * between a reviewer trusting the queue and being confused by it.
 */
export function ProposalAuthor({ createdBy }: { createdBy: string }) {
  const automatic = isSystemAuthor(createdBy)
  const Icon = automatic ? Bot : User
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="font-mono">{createdBy}</span>
      {automatic && <span className="text-muted-foreground/80">· raised automatically</span>}
    </span>
  )
}
