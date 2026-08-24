import { Plus, X } from 'lucide-react'
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
import type { IndividualTarget, Variation } from '@/types/api'
import { variationLabel } from './variationLabel'

export interface IndividualTargetsEditorProps {
  targets: IndividualTarget[]
  variations: readonly Variation[]
  onChange: (targets: IndividualTarget[]) => void
  disabled?: boolean
}

/**
 * Per-context-key overrides. These sit above rules in the evaluation order, so they are the
 * escape hatch for "give this one account the new thing" without touching the rollout.
 */
export function IndividualTargetsEditor({
  targets,
  variations,
  onChange,
  disabled,
}: IndividualTargetsEditorProps) {
  const patch = (index: number, next: Partial<IndividualTarget>) =>
    onChange(targets.map((t, i) => (i === index ? { ...t, ...next } : t)))

  const duplicateKeys = new Set(
    targets
      .map((t) => t.contextKey.trim())
      .filter((key, i, all) => key && all.indexOf(key) !== i),
  )

  return (
    <section className="space-y-3" aria-labelledby="targets-heading">
      <div className="flex items-center justify-between">
        <div>
          <h3 id="targets-heading" className="text-sm font-semibold">
            Individual targets
          </h3>
          <p className="text-xs text-muted-foreground">
            Checked before any rule. One context key gets exactly one variation.
          </p>
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || variations.length === 0}
          data-testid="add-target"
          onClick={() =>
            onChange([...targets, { contextKey: '', variationId: variations[0].id }])
          }
        >
          <Plus className="mr-1 h-3 w-3" /> Add target
        </Button>
      </div>

      {targets.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No individual targets.
        </p>
      ) : (
        <div className="space-y-2 rounded-md border p-4">
          <div className="grid grid-cols-[1fr_220px_auto] gap-2">
            <Label className="text-xs text-muted-foreground">Context key</Label>
            <Label className="text-xs text-muted-foreground">Serves</Label>
            <span />
          </div>
          {targets.map((target, i) => (
            <div key={i} className="grid grid-cols-[1fr_220px_auto] items-center gap-2">
              <Input
                className="h-8 font-mono"
                aria-label={`Target ${i + 1} context key`}
                data-testid={`target-${i}-key`}
                placeholder="user-1234"
                value={target.contextKey}
                disabled={disabled}
                aria-invalid={duplicateKeys.has(target.contextKey.trim())}
                onChange={(e) => patch(i, { contextKey: e.target.value })}
              />
              <Select
                value={target.variationId}
                disabled={disabled}
                onValueChange={(variationId) => patch(i, { variationId })}
              >
                <SelectTrigger
                  className="h-8"
                  aria-label={`Target ${i + 1} variation`}
                  data-testid={`target-${i}-variation`}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {variations.map((v) => (
                    <SelectItem key={v.id} value={v.id}>
                      {variationLabel(v)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`Remove target ${i + 1}`}
                disabled={disabled}
                onClick={() => onChange(targets.filter((_, j) => j !== i))}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {duplicateKeys.size > 0 && (
            <p className="text-xs text-destructive" role="alert">
              Duplicate context keys: {[...duplicateKeys].join(', ')}
            </p>
          )}
        </div>
      )}
    </section>
  )
}
