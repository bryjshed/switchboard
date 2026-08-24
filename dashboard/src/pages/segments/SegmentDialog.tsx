import { useEffect, useState } from 'react'
import { Plus, X } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useToast } from '@/components/ui/use-toast'
import { createSegment, updateSegment } from '@/lib/segmentsApi'
import { errorMessage } from '@/lib/apiClient'
import { slugify, validateKey } from '@/lib/flagKey'
import { CLAUSE_OPS, CLAUSE_OP_LABELS, isSegmentOp } from '@/types/api'
import type { Clause, ClauseOp, Segment, SegmentRule } from '@/types/api'

interface SegmentDialogProps {
  projectId: string
  /** null creates; a segment edits it in place (the key becomes read-only). */
  segment: Segment | null
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved: () => void
}

/** Comma/newline separated list ⇄ array, for the included/excluded key boxes. */
function parseKeyList(value: string): string[] {
  return [...new Set(value.split(/[\s,]+/).map((v) => v.trim()).filter(Boolean))]
}

function KeyListEditor({
  id,
  label,
  description,
  keys,
  onChange,
}: {
  id: string
  label: string
  description: string
  keys: string[]
  onChange: (keys: string[]) => void
}) {
  const [draft, setDraft] = useState('')
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id}>{label}</Label>
      <p className="text-xs text-muted-foreground">{description}</p>
      {keys.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {keys.map((key) => (
            <span
              key={key}
              className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs"
            >
              <span className="font-mono">{key}</span>
              <button
                type="button"
                aria-label={`Remove ${key}`}
                onClick={() => onChange(keys.filter((k) => k !== key))}
                className="text-muted-foreground hover:text-foreground"
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <Input
        id={id}
        data-testid={id}
        className="font-mono"
        value={draft}
        placeholder="user-1, user-2 — press Enter"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            onChange([...new Set([...keys, ...parseKeyList(draft)])])
            setDraft('')
          }
        }}
        onBlur={() => {
          if (draft.trim()) {
            onChange([...new Set([...keys, ...parseKeyList(draft)])])
            setDraft('')
          }
        }}
      />
    </div>
  )
}

export function SegmentDialog({
  projectId,
  segment,
  open,
  onOpenChange,
  onSaved,
}: SegmentDialogProps) {
  const { toast } = useToast()
  const editing = segment !== null
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [includedKeys, setIncludedKeys] = useState<string[]>([])
  const [excludedKeys, setExcludedKeys] = useState<string[]>([])
  const [rules, setRules] = useState<SegmentRule[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setName(segment?.name ?? '')
    setKey(segment?.key ?? '')
    setKeyTouched(false)
    setIncludedKeys(segment?.includedKeys ?? [])
    setExcludedKeys(segment?.excludedKeys ?? [])
    setRules(segment?.rules ?? [])
    setFormError(null)
  }, [open, segment])

  const keyError = editing ? null : keyTouched || key ? validateKey(key, 'Segment key') : null
  const nameError = name.trim() ? null : 'Name is required'
  const rulesError = rules.some((r) =>
    r.clauses.some((c) => !c.attribute.trim() || c.values.length === 0),
  )
    ? 'Every clause needs an attribute and at least one value'
    : null

  const canSubmit = !keyError && !nameError && !rulesError && !submitting

  const patchClause = (ruleIndex: number, clauseIndex: number, patch: Partial<Clause>) =>
    setRules((prev) =>
      prev.map((rule, i) =>
        i === ruleIndex
          ? {
              ...rule,
              clauses: rule.clauses.map((c, j) => (j === clauseIndex ? { ...c, ...patch } : c)),
            }
          : rule,
      ),
    )

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setFormError(null)
    try {
      const body = { key, name: name.trim(), includedKeys, excludedKeys, rules }
      if (editing) await updateSegment(projectId, segment.key, body)
      else await createSegment(projectId, body)
      toast({ title: editing ? `Saved ${key}` : `Created ${key}` })
      onOpenChange(false)
      onSaved()
    } catch (err) {
      setFormError(errorMessage(err, 'Could not save this segment'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${segment.key}` : 'New segment'}</DialogTitle>
          <DialogDescription>
            A context is in the segment when it is not excluded and either is included by key
            or matches one of the rules.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="segment-name">Name</Label>
              <Input
                id="segment-name"
                data-testid="segment-name"
                value={name}
                autoFocus
                onChange={(e) => {
                  setName(e.target.value)
                  if (!editing && !keyTouched) setKey(slugify(e.target.value))
                }}
                placeholder="Beta testers"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="segment-key">Key</Label>
              <Input
                id="segment-key"
                data-testid="segment-key"
                className="font-mono"
                value={key}
                disabled={editing}
                onChange={(e) => {
                  setKeyTouched(true)
                  setKey(e.target.value)
                }}
                aria-invalid={Boolean(keyError)}
                aria-describedby="segment-key-help"
              />
              <p
                id="segment-key-help"
                className={keyError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
              >
                {keyError ?? (editing ? 'Keys are permanent — rules reference them.' : 'Lowercase letters, numbers and hyphens.')}
              </p>
            </div>
          </div>

          <KeyListEditor
            id="segment-included"
            label="Included context keys"
            description="Always in, regardless of the rules."
            keys={includedKeys}
            onChange={setIncludedKeys}
          />
          <KeyListEditor
            id="segment-excluded"
            label="Excluded context keys"
            description="Always out. Excludes beat includes and rules."
            keys={excludedKeys}
            onChange={setExcludedKeys}
          />

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Rules</Label>
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="segment-add-rule"
                onClick={() =>
                  setRules((prev) => [
                    ...prev,
                    { clauses: [{ attribute: 'plan', op: 'EQUALS', values: [] }] },
                  ])
                }
              >
                <Plus className="mr-1 h-3 w-3" /> Add rule
              </Button>
            </div>
            {rules.length === 0 ? (
              <p className="rounded-md border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                No rules. Membership is by included keys only.
              </p>
            ) : (
              rules.map((rule, ruleIndex) => (
                <div key={ruleIndex} className="space-y-2 rounded-md border p-3">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-semibold text-muted-foreground">
                      Rule {ruleIndex + 1} — every clause must match
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete rule ${ruleIndex + 1}`}
                      onClick={() => setRules((prev) => prev.filter((_, i) => i !== ruleIndex))}
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                  {rule.clauses.map((clause, clauseIndex) => (
                    <div key={clauseIndex} className="grid grid-cols-[1fr_150px_1.4fr_auto] gap-2">
                      <Input
                        className="h-8 font-mono"
                        aria-label={`Rule ${ruleIndex + 1} clause ${clauseIndex + 1} attribute`}
                        value={clause.attribute}
                        disabled={isSegmentOp(clause.op)}
                        onChange={(e) =>
                          patchClause(ruleIndex, clauseIndex, { attribute: e.target.value })
                        }
                      />
                      <Select
                        value={clause.op}
                        onValueChange={(op) =>
                          patchClause(ruleIndex, clauseIndex, { op: op as ClauseOp })
                        }
                      >
                        <SelectTrigger
                          className="h-8"
                          aria-label={`Rule ${ruleIndex + 1} clause ${clauseIndex + 1} operator`}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {CLAUSE_OPS.map((op) => (
                            <SelectItem key={op} value={op}>
                              {CLAUSE_OP_LABELS[op]}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Input
                        className="h-8 font-mono"
                        aria-label={`Rule ${ruleIndex + 1} clause ${clauseIndex + 1} values`}
                        placeholder="comma separated"
                        value={clause.values.join(', ')}
                        onChange={(e) =>
                          patchClause(ruleIndex, clauseIndex, { values: parseKeyList(e.target.value) })
                        }
                      />
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        aria-label={`Delete clause ${clauseIndex + 1} of rule ${ruleIndex + 1}`}
                        disabled={rule.clauses.length === 1}
                        onClick={() =>
                          setRules((prev) =>
                            prev.map((r, i) =>
                              i === ruleIndex
                                ? { ...r, clauses: r.clauses.filter((_, j) => j !== clauseIndex) }
                                : r,
                            ),
                          )
                        }
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  ))}
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      setRules((prev) =>
                        prev.map((r, i) =>
                          i === ruleIndex
                            ? { ...r, clauses: [...r.clauses, { attribute: '', op: 'EQUALS', values: [] }] }
                            : r,
                        ),
                      )
                    }
                  >
                    <Plus className="mr-1 h-3 w-3" /> Add clause
                  </Button>
                </div>
              ))
            )}
            {rulesError && <p className="text-xs text-destructive">{rulesError}</p>}
          </div>

          {formError && (
            <p className="text-sm text-destructive" role="alert">
              {formError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} data-testid="segment-submit">
              {submitting ? 'Saving…' : editing ? 'Save segment' : 'Create segment'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
