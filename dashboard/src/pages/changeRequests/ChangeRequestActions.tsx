import { useState } from 'react'
import { Check, Lock, Play, Undo2, X } from 'lucide-react'
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
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useToast } from '@/components/ui/use-toast'
import {
  applyChangeRequest,
  approveChangeRequest,
  declineChangeRequest,
  withdrawChangeRequest,
} from '@/lib/changeRequestsApi'
import { ConflictError, errorMessage } from '@/lib/apiClient'
import {
  canApply,
  canApprove,
  canDecline,
  canWithdraw,
  type ActionAvailability,
} from '@/lib/changeRequestDisplay'
import { useAuth } from '@/hooks/useAuth'
import type { ChangeRequest, Permission } from '@/types/api'

type Action = 'approve' | 'decline' | 'withdraw' | 'apply'

export interface ChangeRequestActionsProps {
  changeRequest: ChangeRequest
  /**
   * The viewer's effective permissions IN THIS REQUEST'S ENVIRONMENT — not the workspace's
   * currently selected one. A reviewer opening a production request from a link while their
   * environment picker sits on dev must be judged against production, so the detail page
   * resolves the scope itself and passes it down. Null while it is still loading.
   */
  permissions: ReadonlySet<Permission> | null
  /** Called with the request's new state after any successful decision. */
  onChanged: (changeRequest: ChangeRequest) => void
  /** Called after a 409, to re-read whatever the winning caller left behind. */
  onRefresh: () => void
}

const COPY: Record<Action, { title: (cr: ChangeRequest) => string; body: string; confirm: string }> = {
  approve: {
    title: (cr) => `Approve this change to ${cr.flagKey}?`,
    body: 'If this approval meets the threshold, Switchboard writes the change and starts serving it immediately, in the same call. It becomes an ordinary new version, so it can be rolled back from the flag’s History tab.',
    confirm: 'Approve',
  },
  decline: {
    title: () => 'Decline this change request?',
    body: 'One decline settles it. The flag is left exactly as it is, and the author has to open a new request if they still want the change.',
    confirm: 'Decline',
  },
  withdraw: {
    title: () => 'Withdraw your change request?',
    body: 'The request is closed and nothing is written. You can edit the flag again and submit a fresh request whenever you are ready.',
    confirm: 'Withdraw',
  },
  apply: {
    title: (cr) => `Apply the approved change to ${cr.flagKey}?`,
    body: 'This request was approved but its write did not land. Applying is idempotent — if it already went through, nothing happens twice. If the flag has moved on since, the request goes stale instead of overwriting the newer version.',
    confirm: 'Apply now',
  },
}

/**
 * Approve / decline / withdraw / apply, each behind a confirmation carrying an optional
 * comment that lands on the review record.
 *
 * Nothing here is shown as an enabled button the backend will refuse. Self-approval in
 * particular is caught in the UI: the server answers 403, and letting someone write a
 * considered review and then hit that wall is worse than saying up front that they cannot
 * sign off on their own change. The hiding is courtesy — the server still enforces all of it.
 */
export function ChangeRequestActions({
  changeRequest,
  permissions,
  onChanged,
  onRefresh,
}: ChangeRequestActionsProps) {
  const { toast } = useToast()
  const { profile } = useAuth()
  const [action, setAction] = useState<Action | null>(null)
  const [comment, setComment] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const ctx = { userId: profile?.id ?? null, permissions }
  const approve = canApprove(changeRequest, ctx)
  const decline = canDecline(changeRequest, ctx)
  const withdraw = canWithdraw(changeRequest, ctx)
  const apply = canApply(changeRequest, ctx)

  const close = () => {
    setAction(null)
    setComment('')
  }

  const submit = async () => {
    if (!action) return
    setSubmitting(true)
    try {
      const body = comment.trim() ? { comment: comment.trim() } : {}
      const next =
        action === 'approve'
          ? await approveChangeRequest(changeRequest.id, body)
          : action === 'decline'
            ? await declineChangeRequest(changeRequest.id, body)
            : action === 'withdraw'
              ? await withdrawChangeRequest(changeRequest.id)
              : await applyChangeRequest(changeRequest.id)
      onChanged(next)
      toast(toastFor(action, next))
      close()
    } catch (err) {
      if (err instanceof ConflictError) {
        toast({
          variant: 'destructive',
          title: 'This request was already decided',
          description: 'Someone else got there first. Reloading the current state.',
        })
        close()
        onRefresh()
      } else {
        toast({
          variant: 'destructive',
          title: `Could not ${action}`,
          description: errorMessage(err),
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Every action unavailable: say why once instead of rendering four dead buttons.
  const anyAvailable = approve.allowed || decline.allowed || withdraw.allowed || apply.allowed
  const blockingReason = firstReason([approve, decline, withdraw, apply])

  return (
    <>
      <div className="space-y-2 rounded-md border p-4" data-testid="cr-actions">
        {anyAvailable ? (
          <div className="flex flex-wrap items-center gap-2">
            {approve.allowed && (
              <Button data-testid="cr-approve" onClick={() => setAction('approve')}>
                <Check className="mr-1 h-4 w-4" /> Approve
              </Button>
            )}
            {decline.allowed && (
              <Button
                variant="outline"
                data-testid="cr-decline"
                onClick={() => setAction('decline')}
              >
                <X className="mr-1 h-4 w-4" /> Decline
              </Button>
            )}
            {apply.allowed && (
              <Button variant="outline" data-testid="cr-apply" onClick={() => setAction('apply')}>
                <Play className="mr-1 h-4 w-4" /> Apply now
              </Button>
            )}
            {withdraw.allowed && (
              <Button
                variant="ghost"
                data-testid="cr-withdraw"
                onClick={() => setAction('withdraw')}
              >
                <Undo2 className="mr-1 h-4 w-4" /> Withdraw
              </Button>
            )}
          </div>
        ) : (
          <p
            className="flex items-start gap-1.5 text-sm text-muted-foreground"
            data-testid="cr-no-actions"
          >
            <Lock className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>{blockingReason}</span>
          </p>
        )}

        {/* Approve hidden but decline available (or vice versa) still deserves an explanation
            — most often "this is your own request and self-approval is off". */}
        {anyAvailable && !approve.allowed && approve.reason && (
          <p className="text-xs text-muted-foreground" data-testid="cr-approve-blocked">
            {approve.reason}
          </p>
        )}
      </div>

      <AlertDialog open={action !== null} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{action && COPY[action].title(changeRequest)}</AlertDialogTitle>
            <AlertDialogDescription>{action && COPY[action].body}</AlertDialogDescription>
          </AlertDialogHeader>
          {action !== 'apply' && (
            <div className="space-y-1.5">
              <Label htmlFor="cr-comment">Comment (optional)</Label>
              <Textarea
                id="cr-comment"
                data-testid="cr-comment"
                rows={3}
                value={comment}
                onChange={(e) => setComment(e.target.value)}
                placeholder={
                  action === 'approve'
                    ? 'Checked the ramp plan with the on-call'
                    : action === 'decline'
                      ? 'Hold this until the migration finishes'
                      : 'Superseded by a wider change'
                }
                autoFocus
              />
              <p className="text-xs text-muted-foreground">
                Kept on the review record so the next person can see the reasoning.
              </p>
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="cr-confirm"
              disabled={submitting}
              className={
                action === 'decline'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : undefined
              }
              onClick={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              {submitting ? 'Working…' : action ? COPY[action].confirm : ''}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

function toastFor(action: Action, cr: ChangeRequest) {
  if (action === 'decline') {
    return { title: 'Change request declined', description: `${cr.flagKey} was left unchanged.` }
  }
  if (action === 'withdraw') {
    return { title: 'Change request withdrawn', description: `${cr.flagKey} was left unchanged.` }
  }
  if (cr.status === 'APPLIED') {
    return {
      title: 'Approved and applied',
      description:
        cr.appliedVersion != null
          ? `${cr.flagKey} is now on version ${cr.appliedVersion} in ${cr.envKey}.`
          : `${cr.flagKey} has been updated in ${cr.envKey}.`,
    }
  }
  if (cr.status === 'STALE') {
    return {
      variant: 'destructive' as const,
      title: 'The flag moved on',
      description: `${cr.flagKey} changed since this request was opened, so it was not applied. It has to be recreated.`,
    }
  }
  return {
    title: 'Approval recorded',
    description: `${cr.flagKey} still needs more approvals before it is applied.`,
  }
}

function firstReason(candidates: readonly ActionAvailability[]): string {
  for (const candidate of candidates) {
    if (candidate.reason) return candidate.reason
  }
  return 'There is nothing to do on this request.'
}
