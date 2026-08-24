import { useState } from 'react'
import { Ban, ShieldCheck } from 'lucide-react'
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
import { setKillSwitch } from '@/lib/flagsApi'
import { errorMessage } from '@/lib/apiClient'
import { cn } from '@/lib/utils'
import { formatDateTime } from '@/lib/format'
import { queuedWriteToast } from '@/lib/changeRequestDisplay'
import { QueuedForReviewNotice } from '@/components/QueuedForReviewNotice'
import { usePermissionGate } from '@/hooks/usePermissions'
import type { ApprovalSettings, ChangeRequest, FlagEnvConfig } from '@/types/api'

export interface KillSwitchControlProps {
  projectId: string
  flagKey: string
  envKey: string
  config: FlagEnvConfig
  /** This environment's approval policy, so the panel can warn when the stop is gated. */
  approvals?: ApprovalSettings
  onChanged: (config: FlagEnvConfig) => void
}

/**
 * The incident control. It deliberately does NOT go through the targeting form: the backend
 * endpoint takes no `expectedVersion`, so killing a flag can never lose a race against
 * someone else's edit, and it never needs the form to be valid first.
 *
 * It also bypasses approval by default, even where targeting writes are gated — a review
 * queue in front of "turn it off now" turns an incident into an outage. An environment can
 * opt in with `requireApprovalForKill`, and when it has, this panel says so BEFORE anyone
 * reaches for the button, because discovering it mid-incident is exactly the wrong moment.
 */
export function KillSwitchControl({
  projectId,
  flagKey,
  envKey,
  config,
  approvals,
  onChanged,
}: KillSwitchControlProps) {
  const { toast } = useToast()
  const killGate = usePermissionGate('FLAG_KILL')
  const [confirming, setConfirming] = useState<'on' | 'off' | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [queued, setQueued] = useState<ChangeRequest | null>(null)

  const active = config.killSwitchActive
  const gated = approvals?.requireApprovalForKill === true

  const apply = async (next: boolean) => {
    setSubmitting(true)
    setQueued(null)
    try {
      const result = await setKillSwitch(projectId, flagKey, envKey, {
        active: next,
        reason: reason.trim() || undefined,
      })
      if (result.outcome === 'queued') {
        setQueued(result.changeRequest)
        toast(queuedWriteToast(result.changeRequest))
      } else {
        onChanged(result.config)
        toast({
          title: next ? `Kill switch ON for ${envKey}` : `Kill switch cleared for ${envKey}`,
          description: next
            ? 'Every context now gets the off variation until this is cleared.'
            : 'Targeting is live again.',
        })
      }
      setConfirming(null)
      setReason('')
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Kill switch failed',
        description: errorMessage(err),
      })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      {queued && <QueuedForReviewNotice changeRequest={queued} />}

      <div
        className={cn(
          'flex items-start justify-between gap-4 rounded-md border p-4',
          active ? 'border-destructive bg-destructive/10' : 'border-destructive/30',
        )}
        data-testid="kill-switch-panel"
      >
        <div className="flex items-start gap-3">
          {active ? (
            <Ban className="mt-0.5 h-5 w-5 shrink-0 text-destructive" aria-hidden />
          ) : (
            <ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div>
            <h3 className="text-sm font-semibold">
              {active ? `Killed in ${envKey}` : 'Kill switch'}
            </h3>
            <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">
              {active
                ? `Every context is being served the off variation, whatever the targeting says. Set ${formatDateTime(config.updatedAt)} by ${config.updatedBy}.`
                : 'Immediately serves the off variation to everyone in this environment, without touching your targeting. Use it first, debug second.'}
            </p>
            {gated && (
              <p
                className="mt-1.5 max-w-xl text-xs text-warning-foreground"
                data-testid="kill-switch-gated"
              >
                {envKey} has put the kill switch behind review. This will not stop anything on
                its own — it opens a change request and waits for a reviewer.
              </p>
            )}
            {!killGate.allowed && (
              <p
                className="mt-1.5 max-w-xl text-xs text-muted-foreground"
                data-testid="kill-switch-locked"
              >
                {killGate.reason}
              </p>
            )}
          </div>
        </div>
        <Button
          variant={active ? 'outline' : 'destructive'}
          data-testid="kill-switch-toggle"
          disabled={!killGate.allowed}
          title={killGate.allowed ? undefined : killGate.reason}
          onClick={() => setConfirming(active ? 'off' : 'on')}
        >
          {active ? 'Clear kill switch' : 'Kill in ' + envKey}
        </Button>
      </div>

      <AlertDialog
        open={confirming !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirming(null)
            setReason('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirming === 'on'
                ? `Kill ${flagKey} in ${envKey}?`
                : `Clear the kill switch in ${envKey}?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {gated
                ? `${envKey} requires approval for the kill switch, so this opens a change request and changes nothing yet. If this is an incident, get a reviewer now.`
                : confirming === 'on'
                  ? 'Every context immediately gets the off variation. Your targeting is preserved and comes back when you clear the switch.'
                  : 'Targeting resumes immediately. Anyone the rules match will start getting their variation again.'}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="kill-reason">Reason</Label>
            <Input
              id="kill-reason"
              data-testid="kill-switch-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={
                confirming === 'on' ? 'Checkout error rate spiked' : 'Fix deployed, rolling back on'
              }
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Recorded on the new version and in the audit log.
            </p>
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="kill-switch-confirm"
              disabled={submitting}
              className={
                confirming === 'on'
                  ? 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
                  : undefined
              }
              onClick={(e) => {
                e.preventDefault()
                void apply(confirming === 'on')
              }}
            >
              {submitting
                ? 'Working…'
                : gated
                  ? 'Submit for review'
                  : confirming === 'on'
                    ? 'Kill it'
                    : 'Clear it'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
