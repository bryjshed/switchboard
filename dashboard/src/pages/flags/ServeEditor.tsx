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
import { RolloutBar, SeriesDot } from '@/components/RolloutBar'
import { cn } from '@/lib/utils'
import { ROLLOUT_TOTAL, rebalanceWeights, sumWeights, validateRolloutWeights } from '@/lib/rollout'
import type { RolloutOrVariation, Variation, WeightedVariation } from '@/types/api'
import { variationLabel } from './variationLabel'

function evenWeights(variations: readonly Variation[]): WeightedVariation[] {
  const base = Math.floor(ROLLOUT_TOTAL / variations.length)
  return variations.map((v, i) => ({
    variationId: v.id,
    weight: i === variations.length - 1 ? ROLLOUT_TOTAL - base * (variations.length - 1) : base,
  }))
}

export interface ServeEditorProps {
  /** Identifies the fields for labels; must be unique on the page. */
  idPrefix: string
  label: string
  description?: string
  variations: readonly Variation[]
  value: RolloutOrVariation
  onChange: (next: RolloutOrVariation) => void
  disabled?: boolean
}

/**
 * Edits one `RolloutOrVariation`: either a single variation, or weights that must sum to
 * exactly 100. The sum is validated live and surfaced next to the inputs — the caller uses
 * the same `validateServe` to block save, so what you see here is what blocks the button.
 */
export function ServeEditor({
  idPrefix,
  label,
  description,
  variations,
  value,
  onChange,
  disabled,
}: ServeEditorProps) {
  const isRollout = Array.isArray(value.rollout) && value.rollout.length > 0
  const weights = value.rollout ?? []
  const total = sumWeights(weights)
  const weightError = isRollout ? validateRolloutWeights(weights) : null

  const setMode = (mode: 'variation' | 'rollout') => {
    if (mode === 'variation') {
      onChange({ variationId: value.variationId ?? variations[0]?.id })
    } else {
      onChange({ rollout: weights.length > 0 ? weights : evenWeights(variations) })
    }
  }

  const setWeight = (index: number, next: number) => {
    onChange({ rollout: rebalanceWeights(weights, index, next) })
  }

  return (
    <div className="space-y-3 rounded-md border p-4" data-testid={`${idPrefix}-serve`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <Label className="text-sm font-semibold">{label}</Label>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        <Select
          value={isRollout ? 'rollout' : 'variation'}
          onValueChange={(v) => setMode(v as 'variation' | 'rollout')}
          disabled={disabled}
        >
          <SelectTrigger
            className="h-8 w-[180px]"
            aria-label={`${label} mode`}
            data-testid={`${idPrefix}-mode`}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="variation">Serve one variation</SelectItem>
            <SelectItem value="rollout">Percentage rollout</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {!isRollout ? (
        <Select
          value={value.variationId ?? ''}
          onValueChange={(variationId) => onChange({ variationId })}
          disabled={disabled}
        >
          <SelectTrigger aria-label={`${label} variation`} data-testid={`${idPrefix}-variation`}>
            <SelectValue placeholder="Choose a variation" />
          </SelectTrigger>
          <SelectContent>
            {variations.map((v) => (
              <SelectItem key={v.id} value={v.id}>
                {variationLabel(v)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <div className="space-y-3">
          {/* Stacked bar: the split at a glance, before reading any numbers. */}
          <RolloutBar
            segments={weights.map((w, i) => ({
              variationId: w.variationId,
              weight: w.weight,
              series: i,
              label: variationLabel(variations.find((v) => v.id === w.variationId)),
            }))}
          />

          {weights.length === 2 && (
            <div className="space-y-1">
              <Label htmlFor={`${idPrefix}-slider`} className="text-xs text-muted-foreground">
                {variationLabel(variations.find((v) => v.id === weights[0].variationId))} share
              </Label>
              <input
                id={`${idPrefix}-slider`}
                data-testid={`${idPrefix}-slider`}
                type="range"
                min={0}
                max={100}
                step={1}
                value={weights[0].weight}
                disabled={disabled}
                onChange={(e) => setWeight(0, Number(e.target.value))}
                className="w-full accent-primary"
              />
            </div>
          )}

          <div className="space-y-2">
            {weights.map((w, i) => {
              const variation = variations.find((v) => v.id === w.variationId)
              return (
                <div key={w.variationId} className="flex items-center gap-3">
                  <SeriesDot series={i} />
                  <span className="min-w-0 flex-1 truncate text-sm">{variationLabel(variation)}</span>
                  <Input
                    type="number"
                    min={0}
                    max={100}
                    className="h-8 w-20 text-right"
                    aria-label={`${variationLabel(variation)} weight`}
                    data-testid={`${idPrefix}-weight-${i}`}
                    value={w.weight}
                    disabled={disabled}
                    onChange={(e) => setWeight(i, Number(e.target.value))}
                  />
                  <span className="w-4 text-sm text-muted-foreground">%</span>
                </div>
              )
            })}
          </div>

          <div className="flex items-center justify-between">
            <p
              className={cn('text-xs', weightError ? 'text-destructive' : 'text-muted-foreground')}
              role={weightError ? 'alert' : undefined}
              data-testid={`${idPrefix}-weight-sum`}
            >
              {weightError ?? `Weights total ${total}%`}
            </p>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              data-testid={`${idPrefix}-distribute`}
              onClick={() => onChange({ rollout: evenWeights(variations) })}
            >
              Distribute evenly
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
