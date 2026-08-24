import { useState } from 'react'
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
import { createFlag } from '@/lib/flagsApi'
import { errorMessage } from '@/lib/apiClient'
import { slugify, validateKey } from '@/lib/flagKey'
import type { FlagDetail, FlagKind, VariationCreate } from '@/types/api'

interface NewFlagDialogProps {
  projectId: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (flag: FlagDetail) => void
}

const MIN_STRING_VARIATIONS = 2

export function NewFlagDialog({ projectId, open, onOpenChange, onCreated }: NewFlagDialogProps) {
  const { toast } = useToast()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyTouched, setKeyTouched] = useState(false)
  const [description, setDescription] = useState('')
  const [kind, setKind] = useState<FlagKind>('BOOLEAN')
  const [tagsInput, setTagsInput] = useState('')
  const [variations, setVariations] = useState<VariationCreate[]>([{ value: '' }, { value: '' }])
  const [submitting, setSubmitting] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const reset = () => {
    setName('')
    setKey('')
    setKeyTouched(false)
    setDescription('')
    setKind('BOOLEAN')
    setTagsInput('')
    setVariations([{ value: '' }, { value: '' }])
    setFormError(null)
  }

  const handleOpenChange = (next: boolean) => {
    if (!next) reset()
    onOpenChange(next)
  }

  // The key auto-slugs from the name until the user edits it themselves, at which point it
  // stops following — otherwise a deliberate key gets silently rewritten on the next keystroke.
  const handleNameChange = (value: string) => {
    setName(value)
    if (!keyTouched) setKey(slugify(value))
  }

  const keyError = keyTouched || key ? validateKey(key, 'Flag key') : null
  const nameError = name.trim() ? null : 'Name is required'
  const stringVariations = variations.filter((v) => v.value.trim().length > 0)
  const variationsError =
    kind === 'STRING'
      ? stringVariations.length < MIN_STRING_VARIATIONS
        ? `String flags need at least ${MIN_STRING_VARIATIONS} variations`
        : new Set(stringVariations.map((v) => v.value.trim())).size !== stringVariations.length
          ? 'Variation values must be unique'
          : null
      : null

  const canSubmit = !keyError && !nameError && !variationsError && !submitting

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setFormError(null)
    try {
      const tags = tagsInput
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
      const flag = await createFlag(projectId, {
        key,
        name: name.trim(),
        description: description.trim() || undefined,
        kind,
        tags: tags.length ? tags : undefined,
        variations:
          kind === 'STRING'
            ? stringVariations.map((v) => ({
                value: v.value.trim(),
                name: v.name?.trim() || undefined,
              }))
            : undefined,
      })
      toast({ title: `Created ${flag.key}` })
      reset()
      onOpenChange(false)
      onCreated(flag)
    } catch (err) {
      setFormError(errorMessage(err, 'Could not create the flag'))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New flag</DialogTitle>
          <DialogDescription>
            The flag is created in every environment of this project, off by default.
          </DialogDescription>
        </DialogHeader>

        <form className="space-y-4" onSubmit={(e) => void handleSubmit(e)}>
          <div className="space-y-1.5">
            <Label htmlFor="flag-name">Name</Label>
            <Input
              id="flag-name"
              data-testid="new-flag-name"
              value={name}
              onChange={(e) => handleNameChange(e.target.value)}
              placeholder="New checkout"
              autoFocus
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="flag-key">Key</Label>
            <Input
              id="flag-key"
              data-testid="new-flag-key"
              className="font-mono"
              value={key}
              onChange={(e) => {
                setKeyTouched(true)
                setKey(e.target.value)
              }}
              placeholder="new-checkout"
              aria-invalid={Boolean(keyError)}
              aria-describedby="flag-key-help"
            />
            <p
              id="flag-key-help"
              className={keyError ? 'text-xs text-destructive' : 'text-xs text-muted-foreground'}
            >
              {keyError ?? 'Lowercase letters, numbers and hyphens. Permanent once created.'}
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="flag-description">Description</Label>
            <Input
              id="flag-description"
              data-testid="new-flag-description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Optional"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label htmlFor="flag-kind">Type</Label>
              <Select value={kind} onValueChange={(v) => setKind(v as FlagKind)}>
                <SelectTrigger id="flag-kind" data-testid="new-flag-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="BOOLEAN">Boolean (true / false)</SelectItem>
                  <SelectItem value="STRING">String (multivariate)</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="flag-tags">Tags</Label>
              <Input
                id="flag-tags"
                data-testid="new-flag-tags"
                value={tagsInput}
                onChange={(e) => setTagsInput(e.target.value)}
                placeholder="checkout, growth"
              />
            </div>
          </div>

          {kind === 'STRING' && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between">
                <Label>Variations</Label>
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  data-testid="new-flag-add-variation"
                  onClick={() => setVariations((v) => [...v, { value: '' }])}
                >
                  <Plus className="mr-1 h-3 w-3" /> Add
                </Button>
              </div>
              {variations.map((variation, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Input
                    aria-label={`Variation ${i + 1} value`}
                    data-testid={`new-flag-variation-${i}`}
                    className="font-mono"
                    value={variation.value}
                    onChange={(e) =>
                      setVariations((prev) =>
                        prev.map((v, j) => (j === i ? { ...v, value: e.target.value } : v)),
                      )
                    }
                    placeholder={`value-${i + 1}`}
                  />
                  <Input
                    aria-label={`Variation ${i + 1} name`}
                    value={variation.name ?? ''}
                    onChange={(e) =>
                      setVariations((prev) =>
                        prev.map((v, j) => (j === i ? { ...v, name: e.target.value } : v)),
                      )
                    }
                    placeholder="Label (optional)"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove variation ${i + 1}`}
                    disabled={variations.length <= MIN_STRING_VARIATIONS}
                    onClick={() => setVariations((prev) => prev.filter((_, j) => j !== i))}
                  >
                    <X className="h-4 w-4" />
                  </Button>
                </div>
              ))}
              {variationsError && <p className="text-xs text-destructive">{variationsError}</p>}
            </div>
          )}

          {formError && (
            <p className="text-sm text-destructive" role="alert">
              {formError}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canSubmit} data-testid="new-flag-submit">
              {submitting ? 'Creating…' : 'Create flag'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
