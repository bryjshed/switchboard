import { useState } from 'react'
import { Check, X } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { applyProposal, rejectProposal } from '@/lib/aiApi'
import { ConflictError, errorMessage } from '@/lib/apiClient'
import type { AiProposal } from '@/types/api'

type Action = 'apply' | 'reject'

export interface ProposalActionsProps {
  proposal: AiProposal
  /** Called with the proposal's new state after a successful apply or reject. */
  onChanged: (proposal: AiProposal) => void
  /** Called after a 409, to re-read whatever the winning caller left behind. */
  onRefresh: () => void
  applyLabel?: string
  rejectLabel?: string
}

/**
 * Apply / reject, both behind a confirmation with an optional reason that lands in the audit
 * trail. Rendered only for a DRAFT: an applied proposal has already written its version and
 * offering the button again would promise something the backend will refuse.
 *
 * The 409 path is a real flow, not an error to shrug at — two reviewers opening the same
 * proposal is exactly what happens when the monitor raises one at 3am. The loser is told
 * plainly that it was already decided, and the page re-reads rather than leaving a stale
 * DRAFT badge on screen.
 */
export function ProposalActions({
  proposal,
  onChanged,
  onRefresh,
  applyLabel = 'Apply',
  rejectLabel = 'Reject',
}: ProposalActionsProps) {
  const { toast } = useToast()
  const [action, setAction] = useState<Action | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)

  if (proposal.status !== 'DRAFT') return null

  const close = () => {
    setAction(null)
    setReason('')
  }

  const submit = async () => {
    if (!action) return
    setSubmitting(true)
    try {
      const body = reason.trim() ? { reason: reason.trim() } : {}
      const next =
        action === 'apply'
          ? await applyProposal(proposal.id, body)
          : await rejectProposal(proposal.id, body)
      onChanged(next)
      toast({
        title: action === 'apply' ? 'Proposal applied' : 'Proposal rejected',
        description:
          action === 'apply'
            ? next.appliedVersion != null
              ? `${next.diff.flagKey} is now on version ${next.appliedVersion}.`
              : `${next.diff.flagKey} has been updated.`
            : `${next.diff.flagKey} was left unchanged.`,
      })
      close()
    } catch (err) {
      if (err instanceof ConflictError) {
        toast({
          variant: 'destructive',
          title:
            action === 'apply'
              ? 'This proposal was already applied'
              : 'This proposal was already decided',
          description: 'Someone else got there first. Reloading the current state.',
        })
        close()
        onRefresh()
      } else {
        toast({
          variant: 'destructive',
          title: action === 'apply' ? 'Could not apply' : 'Could not reject',
          description: errorMessage(err),
        })
      }
    } finally {
      setSubmitting(false)
    }
  }

  const applying = action === 'apply'

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        <Button data-testid="proposal-apply" onClick={() => setAction('apply')}>
          <Check className="mr-1 h-4 w-4" /> {applyLabel}
        </Button>
        <Button
          variant="outline"
          data-testid="proposal-reject"
          onClick={() => setAction('reject')}
        >
          <X className="mr-1 h-4 w-4" /> {rejectLabel}
        </Button>
      </div>

      <AlertDialog open={action !== null} onOpenChange={(open) => !open && close()}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {applying
                ? `Apply this change to ${proposal.diff.flagKey}?`
                : `Reject this proposal?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {applying
                ? 'Switchboard writes a new version of the flag and starts serving it immediately. Nothing in the history is rewritten, so you can roll back from the flag’s History tab.'
                : 'The proposal is closed and the flag is left exactly as it is. Rejecting does not stop the monitor from raising the same finding again if the behaviour continues.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="proposal-reason">Reason (optional)</Label>
            <Input
              id="proposal-reason"
              data-testid="proposal-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                applying ? 'Confirmed the error spike in the dashboards' : 'Expected during the migration'
              }
              autoFocus
            />
            <p className="text-xs text-muted-foreground">Recorded in the audit trail.</p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="proposal-confirm"
              disabled={submitting}
              onClick={(e) => {
                e.preventDefault()
                void submit()
              }}
            >
              {submitting ? 'Working…' : applying ? 'Apply change' : 'Reject proposal'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
