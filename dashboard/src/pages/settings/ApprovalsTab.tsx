import { useCallback, useEffect, useState } from 'react'
import { Minus, Plus, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { EnvChip } from '@/components/EnvChip'
import { InfoCallout } from '@/components/InfoCallout'
import { getApprovalSettings, updateApprovalSettings } from '@/lib/changeRequestsApi'
import { errorMessage } from '@/lib/apiClient'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { ApprovalSettings, ApprovalSettingsUpdateRequest, Environment } from '@/types/api'

const MIN_APPROVALS = 1
const MAX_APPROVALS = 10

/**
 * Per-environment approval policy.
 *
 * The copy here is deliberately blunt about what each switch costs. Turning on approval for
 * production is a good idea; putting the kill switch behind it is a decision with a body
 * count attached, and a settings page that presents the two as equivalent toggles is lying by
 * omission. Off is the default for a reason, and the UI says so where the switch is.
 */
export function ApprovalsTab({ canManage }: { canManage: boolean }) {
  const { environments, project, loading, refresh } = useWorkspace()

  if (loading && environments.length === 0) return <Skeleton className="h-64 w-full max-w-2xl" />

  if (!project) {
    return <p className="text-sm text-muted-foreground">No project selected.</p>
  }

  return (
    <div className="max-w-2xl space-y-6">
      <InfoCallout dismissKey="switchboard.approvals.intro">
        With approval on, editing a flag in that environment does not change anything: it opens
        a change request that a reviewer has to approve, and the approval that meets the
        threshold performs the write. Every environment starts with this off, so one you never
        configure behaves exactly as it did before change requests existed.
      </InfoCallout>

      {!canManage && (
        <InfoCallout>
          You can see each environment's policy, but changing it needs the permission to manage
          environments. Ask an owner or admin.
        </InfoCallout>
      )}

      {environments.map((environment) => (
        <EnvironmentApprovals
          key={environment.id}
          environment={environment}
          canManage={canManage}
          onSaved={() => void refresh()}
        />
      ))}
    </div>
  )
}

function EnvironmentApprovals({
  environment,
  canManage,
  onSaved,
}: {
  environment: Environment
  canManage: boolean
  onSaved: () => void
}) {
  const { toast } = useToast()
  const [settings, setSettings] = useState<ApprovalSettings | null>(environment.approvals ?? null)
  const [loading, setLoading] = useState(environment.approvals == null)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setSettings(await getApprovalSettings(environment.id))
    } catch (err) {
      setError(errorMessage(err, 'Could not load the approval policy'))
    } finally {
      setLoading(false)
    }
  }, [environment.id])

  useEffect(() => {
    if (environment.approvals) {
      setSettings(environment.approvals)
      setLoading(false)
      return
    }
    setLoading(true)
    void load()
  }, [environment.approvals, load])

  /**
   * Optimistic: the control moves at once and snaps back to exactly what the server last
   * confirmed if the write fails. A toggle whose effect is invisible on this screen anyway is
   * the right place for that trade — but "snap back to the previous server state" matters,
   * because guessing would leave the UI claiming a policy the backend does not hold.
   */
  const save = async (patch: ApprovalSettingsUpdateRequest, previous: ApprovalSettings) => {
    setSaving(true)
    try {
      const next = await updateApprovalSettings(environment.id, patch)
      setSettings(next)
      onSaved()
    } catch (err) {
      setSettings(previous)
      toast({
        variant: 'destructive',
        title: `Could not change ${environment.key}'s approval policy`,
        description: errorMessage(err),
      })
    } finally {
      setSaving(false)
    }
  }

  const patch = (next: ApprovalSettingsUpdateRequest) => {
    if (!settings) return
    const previous = settings
    setSettings({ ...settings, ...next })
    void save(next, previous)
  }

  if (loading) return <Skeleton className="h-56 w-full" />

  if (error || !settings) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error ?? 'No approval policy available'}
      </p>
    )
  }

  const locked = !canManage || saving

  return (
    <section
      className="space-y-0 rounded-md border p-4"
      aria-labelledby={`approvals-${environment.key}`}
      data-testid={`approvals-${environment.key}`}
    >
      <div className="flex items-center justify-between gap-4 pb-3">
        <h3 id={`approvals-${environment.key}`} className="flex items-center gap-2 text-sm font-semibold">
          <EnvChip envKey={environment.key} />
          {environment.name}
        </h3>
        <span
          className={cn(
            'text-xs font-medium',
            settings.requireApproval ? 'text-ok-foreground' : 'text-muted-foreground',
          )}
          data-testid={`approvals-state-${environment.key}`}
        >
          {settings.requireApproval ? 'review required' : 'writes go straight through'}
        </span>
      </div>

      <ToggleRow
        id={`require-approval-${environment.key}`}
        title="Require approval for targeting changes and rollbacks"
        description="Saving targeting or rolling back opens a change request instead of writing. The flag keeps serving what it serves now until someone approves."
        checked={settings.requireApproval}
        disabled={locked}
        onChange={(v) => patch({ requireApproval: v })}
      />

      <div className="flex items-start justify-between gap-6 border-t py-4">
        <div className="min-w-0">
          <Label
            htmlFor={`min-approvals-${environment.key}`}
            className={cn('text-sm font-medium', !settings.requireApproval && 'text-muted-foreground')}
          >
            Approvals needed
          </Label>
          <p className="mt-1 text-sm text-muted-foreground">
            How many reviewers have to sign off before the change is written. Two is the usual
            choice for production; one is enough when you mainly want a second pair of eyes.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon"
            aria-label="One fewer approval"
            data-testid={`min-approvals-down-${environment.key}`}
            disabled={locked || !settings.requireApproval || settings.minApprovals <= MIN_APPROVALS}
            onClick={() => patch({ minApprovals: settings.minApprovals - 1 })}
          >
            <Minus className="h-4 w-4" />
          </Button>
          <output
            id={`min-approvals-${environment.key}`}
            data-testid={`min-approvals-${environment.key}`}
            className="w-8 text-center text-sm font-medium tabular-nums"
          >
            {settings.minApprovals}
          </output>
          <Button
            variant="outline"
            size="icon"
            aria-label="One more approval"
            data-testid={`min-approvals-up-${environment.key}`}
            disabled={locked || !settings.requireApproval || settings.minApprovals >= MAX_APPROVALS}
            onClick={() => patch({ minApprovals: settings.minApprovals + 1 })}
          >
            <Plus className="h-4 w-4" />
          </Button>
        </div>
      </div>

      <ToggleRow
        id={`allow-self-approval-${environment.key}`}
        title="Let people approve their own requests"
        description="On, the author's own approval counts toward the threshold — useful for a small team where waiting for someone else means waiting until morning. Off, a change always needs a second person, which is the point of review."
        checked={settings.allowSelfApproval}
        disabled={locked || !settings.requireApproval}
        onChange={(v) => patch({ allowSelfApproval: v })}
      />

      <ToggleRow
        id={`require-approval-kill-${environment.key}`}
        title="Require approval for the kill switch too"
        tone="warning"
        description={
          <>
            The kill switch is the emergency stop, and it bypasses review by default so an
            incident can never be blocked waiting for a reviewer. Turning this on means that
            during an outage, "turn it off now" becomes "open a request and find someone".{' '}
            <strong>Leave it off unless you have reviewers on call around the clock.</strong>
          </>
        }
        checked={settings.requireApprovalForKill}
        disabled={locked}
        onChange={(v) => patch({ requireApprovalForKill: v })}
      />

      {settings.requireApprovalForKill && (
        <Callout
          variant="warning"
          icon={TriangleAlert}
          className="mt-3"
          data-testid={`kill-gated-warning-${environment.key}`}
        >
          The kill switch in {environment.key} is behind review. Nobody can stop this
          environment's flags without an approver.
        </Callout>
      )}

      {!settings.requireApproval && (
        <p className="mt-3 border-t pt-3 text-sm text-muted-foreground">
          Approvals needed and self-approval are inert while review is off. The kill switch
          setting is independent and still applies.
        </p>
      )}
    </section>
  )
}

function ToggleRow({
  id,
  title,
  description,
  checked,
  disabled,
  tone,
  onChange,
}: {
  id: string
  title: string
  description: React.ReactNode
  checked: boolean
  disabled: boolean
  tone?: 'warning'
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-t py-4">
      <div className="min-w-0">
        <Label
          htmlFor={id}
          className={cn('text-sm font-medium', tone === 'warning' && 'text-warning-foreground')}
        >
          {title}
        </Label>
        <p className="mt-1 text-sm text-muted-foreground">{description}</p>
      </div>
      <Switch
        id={id}
        data-testid={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        aria-label={title}
      />
    </div>
  )
}
