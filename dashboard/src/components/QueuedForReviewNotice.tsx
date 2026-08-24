import { Link } from 'react-router-dom'
import { ExternalLink, GitPullRequest } from 'lucide-react'
import { Callout } from '@/components/ui/callout'
import { describeApprovalProgress } from '@/lib/changeRequestDisplay'
import { cn } from '@/lib/utils'
import type { ChangeRequest } from '@/types/api'

/**
 * What a write looks like when the environment sent it to review instead of performing it.
 *
 * The single most dangerous outcome in a gated environment is a person believing they turned
 * something off when they did not, so this states plainly that the flag is unchanged before
 * it says anything else, and hands over a link to the request rather than leaving them to go
 * find it.
 */
export function QueuedForReviewNotice({
  changeRequest,
  className,
}: {
  changeRequest: ChangeRequest
  className?: string
}) {
  return (
    <Callout
      variant="info"
      icon={GitPullRequest}
      className={cn('border-info/40 bg-info/10 text-foreground', className)}
      role="status"
      data-testid="queued-for-review"
    >
      <p className="font-medium">
        Submitted for review — {changeRequest.flagKey} is unchanged in {changeRequest.envKey}
      </p>
      <p className="text-muted-foreground">
        {changeRequest.envKey} requires approval, so nothing was written. Your change is waiting
        as a change request and needs {describeApprovalProgress(changeRequest)} before it goes
        live.
      </p>
      <Link
        to={`/change-requests/${changeRequest.id}`}
        data-testid="queued-for-review-link"
        className="mt-1 inline-flex items-center gap-1 text-sm font-medium underline underline-offset-2"
      >
        Open the change request
        <ExternalLink className="h-3 w-3" aria-hidden />
      </Link>
    </Callout>
  )
}
