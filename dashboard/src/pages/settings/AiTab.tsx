import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Bell, BellOff, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useToast } from '@/components/ui/use-toast'
import { InfoCallout } from '@/components/InfoCallout'
import { getOrgSettings, updateOrgSettings } from '@/lib/orgsApi'
import { errorMessage } from '@/lib/apiClient'
import { usePermissionGate } from '@/hooks/usePermissions'
import { cn } from '@/lib/utils'
import type { Org, OrgSettings, OrgSettingsUpdateRequest } from '@/types/api'

const MIN_WEEKS = 1
const MAX_WEEKS = 52

function ToggleRow({
  id,
  title,
  description,
  checked,
  disabled,
  onChange,
}: {
  id: string
  title: string
  description: React.ReactNode
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  return (
    <div className="flex items-start justify-between gap-6 border-t py-4 first:border-t-0 first:pt-0">
      <div className="min-w-0">
        <Label htmlFor={id} className="text-sm font-medium">
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

/**
 * The AI layer's switches.
 *
 * The two automatic toggles change what Switchboard is allowed to do to production without
 * asking, so the copy states the consequence plainly — and states the floor under it, which
 * is that every automatic action still writes a normal, reversible version with an audit
 * entry. Understating the risk would be dishonest; dressing it up in warnings would push
 * people to leave the product's best feature switched off.
 *
 * Writes are optimistic: the toggle moves immediately and snaps back if the PUT fails, which
 * is the right trade for a control whose effect is not visible on this screen anyway.
 */
export function AiTab({ org }: { org: Org }) {
  const { toast } = useToast()
  const [settings, setSettings] = useState<OrgSettings | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [weeksDraft, setWeeksDraft] = useState('')

  const settingsGate = usePermissionGate('MANAGE_SETTINGS')
  const isOwner = settingsGate.allowed

  const load = useCallback(async () => {
    setError(null)
    try {
      const next = await getOrgSettings(org.id)
      setSettings(next)
      setWeeksDraft(String(next.staleFlagWeeks))
    } catch (err) {
      setError(errorMessage(err, 'Could not load AI settings'))
    } finally {
      setLoading(false)
    }
  }, [org.id])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const save = async (patch: OrgSettingsUpdateRequest, previous: OrgSettings) => {
    setSaving(true)
    try {
      setSettings(await updateOrgSettings(org.id, patch))
    } catch (err) {
      // Snap back to exactly what the server last confirmed, not to a guess.
      setSettings(previous)
      setWeeksDraft(String(previous.staleFlagWeeks))
      toast({ variant: 'destructive', title: 'Could not save', description: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const toggle = (key: keyof OrgSettingsUpdateRequest, value: boolean) => {
    if (!settings) return
    const previous = settings
    setSettings({ ...settings, [key]: value })
    void save({ [key]: value }, previous)
  }

  const commitWeeks = () => {
    if (!settings) return
    const parsed = Number(weeksDraft)
    if (!Number.isInteger(parsed) || parsed < MIN_WEEKS || parsed > MAX_WEEKS) {
      setWeeksDraft(String(settings.staleFlagWeeks))
      return
    }
    if (parsed === settings.staleFlagWeeks) return
    const previous = settings
    setSettings({ ...settings, staleFlagWeeks: parsed })
    void save({ staleFlagWeeks: parsed }, previous)
  }

  if (loading) return <Skeleton className="h-64 w-full max-w-2xl" />

  if (error || !settings) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error ?? 'No settings available'}
      </p>
    )
  }

  const locked = !isOwner || saving

  return (
    <div className="max-w-2xl space-y-6">
      {!isOwner && (
        <InfoCallout>
          These switches decide what Switchboard may change on its own, so changing them needs
          the permission to manage organization settings. You can see the current setting; ask
          an owner to change it.
        </InfoCallout>
      )}

      <section className="rounded-md border p-4">
        <div className={cn('space-y-0', locked && 'opacity-95')}>
          <ToggleRow
            id="ai-enabled"
            title="AI features"
            description="The master switch. Off, Switchboard stops drafting proposals, stops scanning rollouts, and behaves like an ordinary flag service."
            checked={settings.aiEnabled}
            disabled={locked}
            onChange={(v) => toggle('aiEnabled', v)}
          />
          <ToggleRow
            id="auto-rollback-enabled"
            title="Roll back a rollout automatically when a variant starts erroring"
            description={
              <>
                Switchboard stops waiting for you and serves the known-good variation the
                moment a variation's error rate breaks out of the baseline. It writes an
                ordinary new version, so you can undo it from the flag's History tab, and it
                records why in the audit trail. Leave it off if you would rather be paged and
                decide yourself.
              </>
            }
            checked={settings.autoRollbackEnabled}
            disabled={locked || !settings.aiEnabled}
            onChange={(v) => toggle('autoRollbackEnabled', v)}
          />
          <ToggleRow
            id="auto-optimize-enabled"
            title="Ramp up a variant that is winning"
            description={
              <>
                When one variation converts clearly better over enough traffic, Switchboard
                shifts more traffic to it instead of waiting for someone to notice. Same
                mechanics as a rollback: a normal version, reversible, in the audit trail.
                This one changes what users see while an experiment is still running, so teams
                that need a fixed split for the duration should leave it off.
              </>
            }
            checked={settings.autoOptimizeEnabled}
            disabled={locked || !settings.aiEnabled}
            onChange={(v) => toggle('autoOptimizeEnabled', v)}
          />
        </div>

        {!settings.aiEnabled && (
          <p className="mt-4 border-t pt-4 text-sm text-muted-foreground">
            The two automatic switches are inert while AI features are off.
          </p>
        )}
      </section>

      <section className="space-y-2 rounded-md border p-4">
        <Label htmlFor="stale-flag-weeks" className="text-sm font-medium">
          Call a flag stale after
        </Label>
        <div className="flex items-center gap-2">
          <Input
            id="stale-flag-weeks"
            data-testid="stale-flag-weeks"
            type="number"
            min={MIN_WEEKS}
            max={MAX_WEEKS}
            className="w-24"
            disabled={locked}
            value={weeksDraft}
            onChange={(e) => setWeeksDraft(e.target.value)}
            onBlur={commitWeeks}
            onKeyDown={(e) => {
              if (e.key === 'Enter') e.currentTarget.blur()
            }}
          />
          <span className="text-sm text-muted-foreground">weeks without a change</span>
        </div>
        <p className="text-sm text-muted-foreground">
          Past this, Switchboard drafts a retirement proposal with a checklist. It never
          deletes anything — the proposal sits in the queue until someone reads it.
        </p>
      </section>

      <section className="flex items-start justify-between gap-6 rounded-md border p-4">
        <div>
          <p className="text-sm font-medium">Notification webhook</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Where Switchboard posts when it raises a finding or acts on one.
          </p>
        </div>
        <Badge
          variant={settings.notificationWebhookSet ? 'ok' : 'secondary'}
          data-testid="webhook-state"
        >
          {settings.notificationWebhookSet ? (
            <>
              <Bell className="mr-1 h-3 w-3" aria-hidden /> configured
            </>
          ) : (
            <>
              <BellOff className="mr-1 h-3 w-3" aria-hidden /> not set
            </>
          )}
        </Badge>
      </section>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <Sparkles className="h-3.5 w-3.5" aria-hidden />
        <span>
          Everything the AI layer does lands in{' '}
          <Link to="/activity" className="underline underline-offset-2 hover:text-foreground">
            Activity
          </Link>{' '}
          marked as an AI change.
        </span>
        {saving && <span data-testid="ai-settings-saving">Saving…</span>}
      </div>

      <Button
        variant="ghost"
        size="sm"
        data-testid="ai-settings-reload"
        onClick={() => void load()}
        className="text-muted-foreground"
      >
        Reload from server
      </Button>
    </div>
  )
}
