import { useState } from 'react'
import { GripVertical, Plus, X } from 'lucide-react'
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
import { ServeEditor } from './ServeEditor'
import { newRule } from './newRule'
import { CLAUSE_OPS, CLAUSE_OP_LABELS, isSegmentOp } from '@/types/api'
import type { Clause, ClauseOp, Rule, Segment, Variation } from '@/types/api'

function newClause(): Clause {
  return { attribute: 'key', op: 'EQUALS', values: [] }
}

function ValuesEditor({
  clause,
  segments,
  onChange,
  idPrefix,
  disabled,
}: {
  clause: Clause
  segments: readonly Segment[]
  onChange: (values: string[]) => void
  idPrefix: string
  disabled?: boolean
}) {
  const [draft, setDraft] = useState('')
  const segmentMode = isSegmentOp(clause.op)

  const add = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || clause.values.includes(trimmed)) return
    onChange([...clause.values, trimmed])
  }

  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap gap-1">
        {clause.values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs"
          >
            <span className="font-mono">{value}</span>
            <button
              type="button"
              aria-label={`Remove ${value}`}
              disabled={disabled}
              onClick={() => onChange(clause.values.filter((v) => v !== value))}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          </span>
        ))}
        {clause.values.length === 0 && (
          <span className="text-xs text-destructive">Add at least one value</span>
        )}
      </div>

      {segmentMode ? (
        <Select value="" onValueChange={add} disabled={disabled}>
          <SelectTrigger
            className="h-8"
            aria-label="Add segment"
            data-testid={`${idPrefix}-add-segment`}
          >
            <SelectValue placeholder={segments.length ? 'Add a segment' : 'No segments defined'} />
          </SelectTrigger>
          <SelectContent>
            {segments
              .filter((s) => !clause.values.includes(s.key))
              .map((s) => (
                <SelectItem key={s.key} value={s.key}>
                  {s.name} <span className="font-mono text-xs opacity-60">({s.key})</span>
                </SelectItem>
              ))}
          </SelectContent>
        </Select>
      ) : (
        <Input
          className="h-8 font-mono"
          aria-label="Add a value"
          data-testid={`${idPrefix}-add-value`}
          placeholder="Type a value, press Enter"
          value={draft}
          disabled={disabled}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              add(draft)
              setDraft('')
            }
          }}
          onBlur={() => {
            if (draft.trim()) {
              add(draft)
              setDraft('')
            }
          }}
        />
      )}
    </div>
  )
}

export interface RulesEditorProps {
  rules: Rule[]
  variations: readonly Variation[]
  segments: readonly Segment[]
  defaultVariationId: string
  onChange: (rules: Rule[]) => void
  disabled?: boolean
}

/**
 * Ordered targeting rules. Order is significant — the first rule whose clauses all match
 * wins — so the editor exposes move up / move down rather than presenting an unordered set.
 * All clauses within a rule must match (AND); values within a clause are an OR.
 */
export function RulesEditor({
  rules,
  variations,
  segments,
  defaultVariationId,
  onChange,
  disabled,
}: RulesEditorProps) {
  const patchRule = (index: number, patch: Partial<Rule>) =>
    onChange(rules.map((r, i) => (i === index ? { ...r, ...patch } : r)))

  const patchClause = (ruleIndex: number, clauseIndex: number, patch: Partial<Clause>) =>
    patchRule(ruleIndex, {
      clauses: rules[ruleIndex].clauses.map((c, i) =>
        i === clauseIndex ? { ...c, ...patch } : c,
      ),
    })

  const move = (index: number, delta: number) => {
    const target = index + delta
    if (target < 0 || target >= rules.length) return
    const next = [...rules]
    ;[next[index], next[target]] = [next[target], next[index]]
    onChange(next)
  }

  return (
    <section className="space-y-3" aria-labelledby="rules-heading">
      <div className="flex items-center justify-between">
        <div>
          <h3 id="rules-heading" className="text-sm font-semibold">
            Rules
          </h3>
          <p className="text-xs text-muted-foreground">
            Evaluated in order. The first rule whose clauses all match decides what is served.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled}
          data-testid="add-rule"
          onClick={() => onChange([...rules, newRule(defaultVariationId)])}
        >
          <Plus className="mr-1 h-3 w-3" /> Add rule
        </Button>
      </div>

      {rules.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No rules. Everyone falls through to the default below.
        </p>
      ) : (
        rules.map((rule, ruleIndex) => (
          <div
            key={rule.id}
            className="space-y-3 rounded-md border p-4"
            data-testid={`rule-${ruleIndex}`}
          >
            <div className="flex items-center gap-2">
              <GripVertical className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
              <span className="shrink-0 text-xs font-semibold text-muted-foreground">
                Rule {ruleIndex + 1}
              </span>
              <Input
                className="h-8"
                aria-label={`Rule ${ruleIndex + 1} description`}
                placeholder="Description (optional)"
                value={rule.description ?? ''}
                disabled={disabled}
                onChange={(e) => patchRule(ruleIndex, { description: e.target.value })}
              />
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Move rule ${ruleIndex + 1} up`}
                disabled={disabled || ruleIndex === 0}
                onClick={() => move(ruleIndex, -1)}
              >
                ↑
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Move rule ${ruleIndex + 1} down`}
                disabled={disabled || ruleIndex === rules.length - 1}
                onClick={() => move(ruleIndex, 1)}
              >
                ↓
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Delete rule ${ruleIndex + 1}`}
                data-testid={`delete-rule-${ruleIndex}`}
                disabled={disabled}
                onClick={() => onChange(rules.filter((_, i) => i !== ruleIndex))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>

            <div className="space-y-2">
              {rule.clauses.map((clause, clauseIndex) => (
                <div
                  key={clauseIndex}
                  className="grid grid-cols-[1fr_170px_1.5fr_auto] items-start gap-2"
                  data-testid={`rule-${ruleIndex}-clause-${clauseIndex}`}
                >
                  <div className="space-y-1.5">
                    {clauseIndex === 0 && (
                      <Label className="text-xs text-muted-foreground">Attribute</Label>
                    )}
                    <Input
                      className="h-8 font-mono"
                      aria-label={`Rule ${ruleIndex + 1} clause ${clauseIndex + 1} attribute`}
                      value={clause.attribute}
                      disabled={disabled || isSegmentOp(clause.op)}
                      placeholder="plan"
                      onChange={(e) =>
                        patchClause(ruleIndex, clauseIndex, { attribute: e.target.value })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    {clauseIndex === 0 && (
                      <Label className="text-xs text-muted-foreground">Operator</Label>
                    )}
                    <Select
                      value={clause.op}
                      disabled={disabled}
                      onValueChange={(op) =>
                        patchClause(ruleIndex, clauseIndex, {
                          op: op as ClauseOp,
                          // Segment ops carry segment keys, not attribute values — the old
                          // values are meaningless under the new operator.
                          values: isSegmentOp(op as ClauseOp) !== isSegmentOp(clause.op)
                            ? []
                            : clause.values,
                          attribute: isSegmentOp(op as ClauseOp) ? 'segment' : clause.attribute,
                        })
                      }
                    >
                      <SelectTrigger
                        className="h-8"
                        aria-label={`Rule ${ruleIndex + 1} clause ${clauseIndex + 1} operator`}
                        data-testid={`rule-${ruleIndex}-clause-${clauseIndex}-op`}
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
                  </div>
                  <div className="space-y-1.5">
                    {clauseIndex === 0 && (
                      <Label className="text-xs text-muted-foreground">Values</Label>
                    )}
                    <ValuesEditor
                      clause={clause}
                      segments={segments}
                      disabled={disabled}
                      idPrefix={`rule-${ruleIndex}-clause-${clauseIndex}`}
                      onChange={(values) => patchClause(ruleIndex, clauseIndex, { values })}
                    />
                  </div>
                  <div className={clauseIndex === 0 ? 'pt-6' : ''}>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete clause ${clauseIndex + 1} of rule ${ruleIndex + 1}`}
                      disabled={disabled || rule.clauses.length === 1}
                      onClick={() =>
                        patchRule(ruleIndex, {
                          clauses: rule.clauses.filter((_, i) => i !== clauseIndex),
                        })
                      }
                    >
                      <X className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
              ))}
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={disabled}
                data-testid={`rule-${ruleIndex}-add-clause`}
                onClick={() => patchRule(ruleIndex, { clauses: [...rule.clauses, newClause()] })}
              >
                <Plus className="mr-1 h-3 w-3" /> Add clause (AND)
              </Button>
            </div>

            <ServeEditor
              idPrefix={`rule-${ruleIndex}`}
              label="Serve"
              variations={variations}
              value={rule.serve}
              disabled={disabled}
              onChange={(serve) => patchRule(ruleIndex, { serve })}
            />
          </div>
        ))
      )}
    </section>
  )
}
