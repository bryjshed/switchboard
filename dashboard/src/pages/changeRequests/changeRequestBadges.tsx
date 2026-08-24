import { Ban, GitPullRequest, RotateCcw } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import {
  CHANGE_REQUEST_KIND_LABELS,
  changeRequestStatusMeta,
  formatApprovalProgress,
} from '@/lib/changeRequestDisplay'
import type { ChangeRequest, ChangeRequestKind, ChangeRequestStatus } from '@/types/api'

export function ChangeRequestStatusBadge({ status }: { status: ChangeRequestStatus }) {
  const meta = changeRequestStatusMeta(status)
  return (
    <Badge variant={meta.variant} data-testid={`cr-status-${status}`}>
      {meta.label}
    </Badge>
  )
}

const KIND_ICONS: Record<ChangeRequestKind, typeof GitPullRequest> = {
  TARGETING_UPDATE: GitPullRequest,
  KILL_SWITCH: Ban,
  ROLLBACK: RotateCcw,
}

export function ChangeRequestKindBadge({ kind }: { kind: ChangeRequestKind }) {
  const Icon = KIND_ICONS[kind]
  // The kill switch is the one kind that takes the flag away from everybody, so it carries
  // the warning tint; the other two are ordinary edits waiting for a signature.
  const variant = kind === 'KILL_SWITCH' ? 'warning' : 'outline'
  return (
    <Badge variant={variant} className="gap-1" data-testid={`cr-kind-${kind}`}>
      <Icon className="h-3 w-3" aria-hidden />
      {CHANGE_REQUEST_KIND_LABELS[kind]}
    </Badge>
  )
}

/**
 * "1 of 2" with the count filled in as approvals land. Reads as a fraction rather than a
 * progress bar because the numbers are small and the exact remainder is the useful part.
 */
export function ApprovalProgress({
  changeRequest,
  className,
}: {
  changeRequest: Pick<ChangeRequest, 'approvalsMet' | 'minApprovals' | 'status'>
  className?: string
}) {
  const text = formatApprovalProgress(changeRequest)
  const complete = changeRequest.approvalsMet >= changeRequest.minApprovals
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 font-mono text-xs',
        complete ? 'text-ok-foreground' : 'text-muted-foreground',
        className,
      )}
      data-testid="cr-approval-progress"
      title={`${text} approvals`}
    >
      {text} <span className="font-sans">approvals</span>
    </span>
  )
}
