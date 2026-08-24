import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, RotateCcw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { EnvChip } from '@/components/EnvChip'
import { KillSwitchControl } from './KillSwitchControl'
import { IndividualTargetsEditor } from './IndividualTargetsEditor'
import { RulesEditor } from './RulesEditor'
import { ServeEditor } from './ServeEditor'
import { variationLabel } from './variationLabel'
import { updateFlagEnvConfig } from '@/lib/flagsApi'
import { ConflictError, errorMessage } from '@/lib/apiClient'
import { validateServe } from '@/lib/rollout'
import { formatDateTime } from '@/lib/format'
import { queuedWriteToast } from '@/lib/changeRequestDisplay'
import { QueuedForReviewNotice } from '@/components/QueuedForReviewNotice'
import { usePermissionGate } from '@/hooks/usePermissions'
import type {
  ApprovalSettings,
  ChangeRequest,
  FlagDetail,
  FlagEnvConfig,
  FlagTargetingConfig,
  Segment,
} from '@/types/api'

export interface TargetingTabProps {
  projectId: string
  flag: FlagDetail
  config: FlagEnvConfig
  segments: readonly Segment[]
  /**
   * This environment's approval policy, when the workspace knows it. Drives the copy on the
   * save button: in a gated environment the button opens a review, and calling it "Save"
   * would promise something it does not do.
   */
  approvals?: ApprovalSettings
  /** Replaces the env config in the parent's flag state after any successful write. */
  onConfigChanged: (config: FlagEnvConfig) => void
  /** Re-fetches the flag from the backend; used to recover from a 409. */
  onReload: () => Promise<FlagEnvConfig | null>
}

function cloneConfig(config: FlagTargetingConfig): FlagTargetingConfig {
  return structuredClone(config)
}

export function TargetingTab({
  projectId,
  flag,
  config,
  segments,
  approvals,
  onConfigChanged,
  onReload,
}: TargetingTabProps) {
  const { toast } = useToast()
  const writeGate = usePermissionGate('FLAG_WRITE')
  const [enabled, setEnabled] = useState(config.enabled)
  const [draft, setDraft] = useState<FlagTargetingConfig>(() => cloneConfig(config.config))
  const [comment, setComment] = useState('')
  const [saving, setSaving] = useState(false)
  // A 409 is a first-class flow here, not a generic failure: someone else wrote a newer
  // version while this form was open. It gets its own banner with a reload affordance.
  const [conflict, setConflict] = useState<string | null>(null)
  // A 202: the write did NOT happen and a change request stands in for it. Held on screen
  // until the next edit, because a toast is too easy to miss for something this consequential.
  const [queued, setQueued] = useState<ChangeRequest | null>(null)

  // Re-seed the form whenever the underlying config changes identity (env switch, save,
  // rollback, kill switch, conflict reload). Version is the identity: every write bumps it.
  useEffect(() => {
    setEnabled(config.enabled)
    setDraft(cloneConfig(config.config))
    setComment('')
    setConflict(null)
    setQueued(null)
  }, [config.environmentId, config.version, config.enabled, config.config])

  const dirty = useMemo(
    () =>
      enabled !== config.enabled ||
      JSON.stringify(draft) !== JSON.stringify(config.config),
    [enabled, draft, config],
  )

  const validationError = useMemo(() => {
    const fallthroughError = validateServe(draft.fallthrough, 'Default rollout')
    if (fallthroughError) return fallthroughError
    for (const [i, rule] of (draft.rules ?? []).entries()) {
      const serveError = validateServe(rule.serve, `Rule ${i + 1}`)
      if (serveError) return serveError
      if (rule.clauses.length === 0) return `Rule ${i + 1} needs at least one clause`
      for (const clause of rule.clauses) {
        if (!clause.attribute.trim()) return `Rule ${i + 1} has a clause with no attribute`
        if (clause.values.length === 0) return `Rule ${i + 1} has a clause with no values`
      }
    }
    for (const target of draft.individualTargets ?? []) {
      if (!target.contextKey.trim()) return 'An individual target has no context key'
    }
    if (!draft.offVariationId) return 'Pick an off variation'
    if (!draft.defaultVariationId) return 'Pick a default variation'
    return null
  }, [draft])

  const patch = useCallback(
    (next: Partial<FlagTargetingConfig>) => setDraft((prev) => ({ ...prev, ...next })),
    [],
  )

  const handleSave = async () => {
    if (validationError) return
    setSaving(true)
    setConflict(null)
    setQueued(null)
    try {
      const result = await updateFlagEnvConfig(projectId, flag.key, config.envKey, {
        enabled,
        config: draft,
        // Always sent: omitting it force-writes over whatever landed in the meantime.
        expectedVersion: config.version,
        comment: comment.trim() || undefined,
      })
      if (result.outcome === 'queued') {
        // Nothing was written. The form keeps the edits on screen so they are not lost, and
        // the banner says so before anything else does.
        setQueued(result.changeRequest)
        toast(queuedWriteToast(result.changeRequest))
      } else {
        onConfigChanged(result.config)
        toast({
          title: `Saved ${flag.key} in ${config.envKey}`,
          description: `Now at version ${result.config.version}.`,
        })
      }
    } catch (err) {
      if (err instanceof ConflictError) {
        setConflict(err.message)
      } else {
        toast({ variant: 'destructive', title: 'Save failed', description: errorMessage(err) })
      }
    } finally {
      setSaving(false)
    }
  }

  const handleReloadAfterConflict = async () => {
    const fresh = await onReload()
    if (fresh) {
      setEnabled(fresh.enabled)
      setDraft(cloneConfig(fresh.config))
      setConflict(null)
      toast({
        title: `Reloaded version ${fresh.version}`,
        description: 'Your unsaved edits were discarded. Re-apply them on top of the new config.',
      })
    }
  }

  const handleDiscard = () => {
    setEnabled(config.enabled)
    setDraft(cloneConfig(config.config))
    setComment('')
  }

  const gated = approvals?.requireApproval === true
  const locked = !writeGate.allowed
  const busy = saving || locked

  return (
    <div className="space-y-6">
      {queued && <QueuedForReviewNotice changeRequest={queued} />}

      {conflict && (
        <div
          className="space-y-3 rounded-md border border-warning/50 bg-warning/10 p-4"
          role="alert"
          data-testid="conflict-banner"
        >
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-warning-foreground" aria-hidden />
            <div>
              <h3 className="text-sm font-semibold text-warning-foreground">
                Changed elsewhere while you were editing
              </h3>
              <p className="mt-1 text-sm text-warning-foreground/90">
                {conflict} Nothing was saved — your edits are still on screen. Load the current
                config to see what changed, then re-apply your edits on top of it.
              </p>
            </div>
          </div>
          <div className="flex gap-2 pl-8">
            <Button
              size="sm"
              variant="outline"
              data-testid="conflict-reload"
              onClick={() => void handleReloadAfterConflict()}
            >
              <RotateCcw className="mr-1 h-3 w-3" /> Load current config (discards your edits)
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setConflict(null)}>
              Keep editing
            </Button>
          </div>
        </div>
      )}

      <KillSwitchControl
        projectId={projectId}
        flagKey={flag.key}
        envKey={config.envKey}
        config={config}
        approvals={approvals}
        onChanged={onConfigChanged}
      />

      <div className="flex items-center justify-between rounded-md border p-4">
        <div>
          <h3 className="text-sm font-semibold">
            Flag is {enabled ? 'on' : 'off'} in <EnvChip envKey={config.envKey} />
          </h3>
          <p className="mt-0.5 text-xs text-muted-foreground">
            When off, everyone gets the off variation and no rule is evaluated.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Label htmlFor="targeting-enabled" className="text-xs text-muted-foreground">
            {enabled ? 'On' : 'Off'}
          </Label>
          <Switch
            id="targeting-enabled"
            data-testid="enabled-toggle"
            checked={enabled}
            disabled={busy}
            onCheckedChange={setEnabled}
            aria-label="Flag enabled in this environment"
          />
        </div>
      </div>

      <IndividualTargetsEditor
        targets={draft.individualTargets ?? []}
        variations={flag.variations}
        disabled={busy}
        onChange={(individualTargets) => patch({ individualTargets })}
      />

      <RulesEditor
        rules={draft.rules ?? []}
        variations={flag.variations}
        segments={segments}
        defaultVariationId={draft.defaultVariationId}
        disabled={busy}
        onChange={(rules) => patch({ rules })}
      />

      <ServeEditor
        idPrefix="fallthrough"
        label="Default (fallthrough)"
        description="What everyone who matched no rule gets. A rollout here is the ramp."
        variations={flag.variations}
        value={draft.fallthrough}
        disabled={busy}
        onChange={(fallthrough) => patch({ fallthrough })}
      />

      <section className="grid gap-4 rounded-md border p-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="off-variation">Off variation</Label>
          <Select
            value={draft.offVariationId}
            disabled={busy}
            onValueChange={(offVariationId) => patch({ offVariationId })}
          >
            <SelectTrigger id="off-variation" data-testid="off-variation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {flag.variations.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {variationLabel(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Served when the flag is off or killed.
          </p>
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="default-variation">Default variation</Label>
          <Select
            value={draft.defaultVariationId}
            disabled={busy}
            onValueChange={(defaultVariationId) => patch({ defaultVariationId })}
          >
            <SelectTrigger id="default-variation" data-testid="default-variation">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {flag.variations.map((v) => (
                <SelectItem key={v.id} value={v.id}>
                  {variationLabel(v)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            The flag's baseline value for this environment.
          </p>
        </div>
      </section>

      {/* Save bar */}
      <div className="sticky bottom-0 -mx-6 -mb-6 flex flex-wrap items-center gap-3 border-t bg-card px-6 py-3">
        <div className="min-w-0 flex-1">
          <Input
            aria-label="Change note"
            data-testid="save-comment"
            placeholder={
              gated
                ? 'Why this change (the reviewer reads this)'
                : 'Change note (recorded on the new version)'
            }
            value={comment}
            disabled={busy}
            onChange={(e) => setComment(e.target.value)}
          />
        </div>
        <p className="text-xs text-muted-foreground">
          v{config.version} · {formatDateTime(config.updatedAt)} by {config.updatedBy}
        </p>
        <Button variant="ghost" onClick={handleDiscard} disabled={!dirty || busy}>
          Discard
        </Button>
        <Button
          data-testid="save-targeting"
          onClick={() => void handleSave()}
          disabled={!dirty || busy || Boolean(validationError)}
          title={locked ? writeGate.reason : (validationError ?? undefined)}
        >
          {saving
            ? gated
              ? 'Submitting…'
              : 'Saving…'
            : gated
              ? 'Submit for review'
              : 'Save changes'}
        </Button>
      </div>
      {locked && (
        <p className="text-right text-xs text-muted-foreground" data-testid="targeting-locked">
          {writeGate.reason}
        </p>
      )}
      {gated && !locked && (
        <p className="text-right text-xs text-muted-foreground" data-testid="targeting-gated">
          {config.envKey} requires approval: saving opens a change request and writes nothing
          until {approvals.minApprovals === 1 ? 'someone approves' : `${approvals.minApprovals} people approve`} it.
        </p>
      )}
      {validationError && (
        <p className="text-right text-xs text-destructive" role="alert" data-testid="targeting-validation">
          {validationError}
        </p>
      )}
    </div>
  )
}
