import { useCallback, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { KeyRound, Sparkles } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Textarea } from '@/components/ui/textarea'
import { ApiClientError, errorMessage } from '@/lib/apiClient'
import { draftProposal } from '@/lib/aiApi'
import { getFlag } from '@/lib/flagsApi'
import { useWorkspace } from '@/hooks/useWorkspace'
import { DiffPreview } from './DiffPreview'
import { ProposalActions } from './ProposalActions'
import type { AiProposal, FlagDetail } from '@/types/api'

/** Concrete, copy-pastable, and each one exercises a different shape of change. */
const EXAMPLES = [
  'release the new planner to 10% of iOS users on Pro',
  'kill the payments experiment in production',
  'turn dark-mode fully on in dev',
]

export interface AskAiDialogProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Pre-scopes the prompt to one flag when opened from a flag's detail page. */
  flagKey?: string
  /** Default environment selection; falls back to the workspace's current one. */
  defaultEnvKey?: string
  /** The proposal after a successful apply — the caller decides where to go next. */
  onApplied?: (proposal: AiProposal) => void
}

/**
 * Natural language in, a reviewable diff out. The dialog never writes anything on its own:
 * drafting produces a DRAFT proposal, and applying it goes through the same confirmation and
 * the same 409 handling as the proposals page.
 *
 * The 503 `AI_UNAVAILABLE` path is a first-class state, not an error. A Switchboard install
 * with no model provider is perfectly functional — the monitor still detects a variant
 * erroring, still rolls it back, still raises proposals — it just cannot take dictation. So
 * that case renders as a calm explanation with submit disabled, and the toast is reserved
 * for failures that are actually the operator's problem.
 */
export function AskAiDialog({
  projectId,
  open,
  onOpenChange,
  flagKey,
  defaultEnvKey,
  onApplied,
}: AskAiDialogProps) {
  const { environments, environment } = useWorkspace()

  const [prompt, setPrompt] = useState('')
  const [envKey, setEnvKey] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState(false)
  const [proposal, setProposal] = useState<AiProposal | null>(null)
  const [flag, setFlag] = useState<FlagDetail | null>(null)
  const [flagLoading, setFlagLoading] = useState(false)

  const reset = useCallback(() => {
    setPrompt('')
    setSubmitting(false)
    setError(null)
    setUnavailable(false)
    setProposal(null)
    setFlag(null)
    setFlagLoading(false)
  }, [])

  // Keyed on the env KEY, not the environment object: the workspace hands back a fresh
  // object on unrelated re-renders, and depending on it would reset the user's selection
  // mid-dialog.
  const currentEnvKey = environment?.key
  useEffect(() => {
    if (open) {
      setEnvKey(defaultEnvKey ?? currentEnvKey ?? '')
    } else {
      reset()
    }
  }, [open, defaultEnvKey, currentEnvKey, reset])

  const submit = async () => {
    const trimmed = prompt.trim()
    if (!trimmed) return
    setSubmitting(true)
    setError(null)
    try {
      const drafted = await draftProposal(projectId, {
        prompt: trimmed,
        environmentKey: envKey || undefined,
        flagKey,
      })
      setProposal(drafted)
      // The diff reads as before → after only when we can see the flag's current state.
      setFlagLoading(true)
      try {
        setFlag(await getFlag(projectId, drafted.diff.flagKey))
      } catch {
        setFlag(null)
      } finally {
        setFlagLoading(false)
      }
    } catch (err) {
      if (err instanceof ApiClientError && err.code === 'AI_UNAVAILABLE') {
        setUnavailable(true)
      } else {
        setError(errorMessage(err, 'Could not draft that change'))
      }
    } finally {
      setSubmitting(false)
    }
  }

  const reviewing = proposal !== null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="h-4 w-4" aria-hidden />
            {reviewing ? 'Review the drafted change' : 'Ask AI'}
          </DialogTitle>
          <DialogDescription>
            {reviewing
              ? 'Nothing has changed yet. This is a draft — read it, then apply or discard.'
              : flagKey
                ? `Describe the change you want to ${flagKey} in plain English.`
                : 'Describe the change you want in plain English. You review the diff before anything is written.'}
          </DialogDescription>
        </DialogHeader>

        {unavailable ? (
          <div className="space-y-3" data-testid="ask-ai-unavailable">
            <Callout variant="info" icon={KeyRound}>
              <p className="font-medium text-foreground">AI drafting is not configured</p>
              <p>
                Turning a sentence into a flag change needs a model provider. Set{' '}
                <code className="font-mono">ANTHROPIC_API_KEY</code> on the Switchboard server
                and this dialog starts working — no data migration, no restart of anything else.
              </p>
            </Callout>
            <p className="text-sm text-muted-foreground">
              Everything else in the AI layer runs without it. Switchboard is still watching
              your rollouts, still rolling back a variation that starts erroring, and still
              raising proposals you can review on the{' '}
              <Link to="/monitor" className="underline underline-offset-2 hover:text-foreground">
                Monitor
              </Link>{' '}
              screen.
            </p>
          </div>
        ) : reviewing && proposal ? (
          <div className="space-y-4">
            {proposal.rationale && (
              <Callout variant="info" icon={Sparkles}>
                {proposal.rationale}
              </Callout>
            )}
            <DiffPreview diff={proposal.diff} flag={flag} flagLoading={flagLoading} />
          </div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="ask-ai-prompt">What should change?</Label>
              <Textarea
                id="ask-ai-prompt"
                data-testid="ask-ai-prompt"
                rows={3}
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                placeholder="Ramp new-checkout to 50% in staging"
                autoFocus
              />
            </div>

            <div className="space-y-1.5">
              <p className="text-xs text-muted-foreground">Try one of these:</p>
              <div className="flex flex-wrap gap-1.5">
                {EXAMPLES.map((example) => (
                  <button
                    key={example}
                    type="button"
                    data-testid={`ask-ai-example-${EXAMPLES.indexOf(example)}`}
                    onClick={() => setPrompt(example)}
                    className="rounded-full border px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
                  >
                    {example}
                  </button>
                ))}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="ask-ai-env">Environment (optional)</Label>
              <Select value={envKey || 'any'} onValueChange={(v) => setEnvKey(v === 'any' ? '' : v)}>
                <SelectTrigger id="ask-ai-env" data-testid="ask-ai-env" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Let the prompt decide</SelectItem>
                  {environments.map((env) => (
                    <SelectItem key={env.id} value={env.key}>
                      {env.key}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            {error && (
              <p className="text-sm text-destructive" role="alert" data-testid="ask-ai-error">
                {error}
              </p>
            )}
          </div>
        )}

        <DialogFooter>
          {unavailable ? (
            <Button variant="outline" onClick={() => onOpenChange(false)} data-testid="ask-ai-close">
              Close
            </Button>
          ) : reviewing && proposal ? (
            <ProposalActions
              proposal={proposal}
              applyLabel="Apply change"
              rejectLabel="Discard"
              onChanged={(next) => {
                setProposal(next)
                onOpenChange(false)
                // Discard rejects the draft; only an actual apply is worth navigating to.
                if (next.status === 'APPLIED') onApplied?.(next)
              }}
              onRefresh={() => onOpenChange(false)}
            />
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                data-testid="ask-ai-submit"
                disabled={submitting || prompt.trim().length === 0}
                onClick={() => void submit()}
              >
                {submitting ? 'Drafting…' : 'Draft change'}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
