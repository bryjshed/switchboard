import { useEffect, useState } from 'react'
import { Archive, Plus, X } from 'lucide-react'
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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { usePermissionGate } from '@/hooks/usePermissions'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useToast } from '@/components/ui/use-toast'
import { archiveFlag, updateFlag } from '@/lib/flagsApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/format'
import type { FlagDetail, VariationCreate } from '@/types/api'
import { variationLabel } from './variationLabel'

export interface FlagSettingsTabProps {
  projectId: string
  flag: FlagDetail
  onUpdated: (flag: FlagDetail) => void
  onArchived: () => void
}

export function FlagSettingsTab({ projectId, flag, onUpdated, onArchived }: FlagSettingsTabProps) {
  const writeGate = usePermissionGate('FLAG_WRITE')
  const { toast } = useToast()
  const [name, setName] = useState(flag.name)
  const [description, setDescription] = useState(flag.description ?? '')
  const [tags, setTags] = useState<string[]>(flag.tags)
  const [tagDraft, setTagDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [newVariations, setNewVariations] = useState<VariationCreate[]>([])
  const [addingVariations, setAddingVariations] = useState(false)
  const [archiveOpen, setArchiveOpen] = useState(false)
  const [archiving, setArchiving] = useState(false)

  useEffect(() => {
    setName(flag.name)
    setDescription(flag.description ?? '')
    setTags(flag.tags)
  }, [flag])

  const dirty =
    name !== flag.name ||
    description !== (flag.description ?? '') ||
    JSON.stringify(tags) !== JSON.stringify(flag.tags)

  const addTag = (value: string) => {
    const trimmed = value.trim()
    if (!trimmed || tags.includes(trimmed)) return
    setTags([...tags, trimmed])
  }

  const handleSave = async () => {
    if (!name.trim()) return
    setSaving(true)
    try {
      const updated = await updateFlag(projectId, flag.key, {
        name: name.trim(),
        description: description.trim(),
        tags,
      })
      onUpdated(updated)
      toast({ title: 'Flag details saved' })
    } catch (err) {
      toast({ variant: 'destructive', title: 'Save failed', description: errorMessage(err) })
    } finally {
      setSaving(false)
    }
  }

  const handleAddVariations = async () => {
    const additions = newVariations
      .filter((v) => v.value.trim())
      .map((v) => ({ value: v.value.trim(), name: v.name?.trim() || undefined }))
    if (additions.length === 0) return
    setAddingVariations(true)
    try {
      const updated = await updateFlag(projectId, flag.key, { addVariations: additions })
      onUpdated(updated)
      setNewVariations([])
      toast({ title: `Added ${additions.length} variation${additions.length === 1 ? '' : 's'}` })
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not add variations', description: errorMessage(err) })
    } finally {
      setAddingVariations(false)
    }
  }

  const handleArchive = async () => {
    setArchiving(true)
    try {
      await archiveFlag(projectId, flag.key)
      toast({ title: `Archived ${flag.key}` })
      onArchived()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Archive failed', description: errorMessage(err) })
    } finally {
      setArchiving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-8">
      <section className="space-y-4" aria-labelledby="details-heading">
        <h3 id="details-heading" className="text-sm font-semibold">
          Details
        </h3>

        <div className="space-y-1.5">
          <Label htmlFor="settings-key">Key</Label>
          <Input id="settings-key" className="font-mono" value={flag.key} disabled readOnly />
          <p className="text-xs text-muted-foreground">
            Keys are permanent — SDKs evaluate against them. Created {formatDateTime(flag.createdAt)}.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-name">Name</Label>
          <Input
            id="settings-name"
            data-testid="settings-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            aria-invalid={!name.trim()}
          />
          {!name.trim() && <p className="text-xs text-destructive">Name is required</p>}
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-description">Description</Label>
          <Input
            id="settings-description"
            data-testid="settings-description"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What this flag controls"
          />
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="settings-tags">Tags</Label>
          <div className="flex flex-wrap gap-1">
            {tags.map((tag) => (
              <span
                key={tag}
                className="inline-flex items-center gap-1 rounded-full border bg-muted/50 px-2 py-0.5 text-xs"
              >
                {tag}
                <button
                  type="button"
                  aria-label={`Remove tag ${tag}`}
                  onClick={() => setTags(tags.filter((t) => t !== tag))}
                  className="text-muted-foreground hover:text-foreground"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
          <Input
            id="settings-tags"
            data-testid="settings-tags"
            value={tagDraft}
            onChange={(e) => setTagDraft(e.target.value)}
            placeholder="Type a tag, press Enter"
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                addTag(tagDraft)
                setTagDraft('')
              }
            }}
          />
        </div>

        <Button
          data-testid="settings-save"
          onClick={() => void handleSave()}
          disabled={!dirty || saving || !name.trim() || !writeGate.allowed}
          title={writeGate.allowed ? undefined : writeGate.reason}
        >
          {saving ? 'Saving…' : 'Save details'}
        </Button>
      </section>

      <section className="space-y-3" aria-labelledby="variations-heading">
        <div>
          <h3 id="variations-heading" className="text-sm font-semibold">
            Variations
          </h3>
          <p className="text-xs text-muted-foreground">
            {flag.kind === 'BOOLEAN'
              ? 'Boolean flags always have exactly true and false.'
              : 'Variations are add-only: existing versions reference them by id, so removing one would break history.'}
          </p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          {flag.variations.map((v) => (
            <Badge key={v.id} variant="outline" className="font-mono text-[11px]">
              {variationLabel(v)}
            </Badge>
          ))}
        </div>

        {flag.kind === 'STRING' && (
          <div className="space-y-2 rounded-md border p-3">
            {newVariations.map((variation, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  className="h-8 font-mono"
                  aria-label={`New variation ${i + 1} value`}
                  data-testid={`add-variation-${i}`}
                  value={variation.value}
                  placeholder="value"
                  onChange={(e) =>
                    setNewVariations((prev) =>
                      prev.map((v, j) => (j === i ? { ...v, value: e.target.value } : v)),
                    )
                  }
                />
                <Input
                  className="h-8"
                  aria-label={`New variation ${i + 1} name`}
                  value={variation.name ?? ''}
                  placeholder="Label (optional)"
                  onChange={(e) =>
                    setNewVariations((prev) =>
                      prev.map((v, j) => (j === i ? { ...v, name: e.target.value } : v)),
                    )
                  }
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove new variation ${i + 1}`}
                  onClick={() => setNewVariations((prev) => prev.filter((_, j) => j !== i))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                data-testid="add-variation-row"
                onClick={() => setNewVariations((v) => [...v, { value: '' }])}
              >
                <Plus className="mr-1 h-3 w-3" /> Add variation
              </Button>
              {newVariations.length > 0 && (
                <Button
                  type="button"
                  size="sm"
                  data-testid="save-variations"
                  disabled={
                    addingVariations ||
                    !newVariations.some((v) => v.value.trim()) ||
                    !writeGate.allowed
                  }
                  onClick={() => void handleAddVariations()}
                >
                  {addingVariations ? 'Adding…' : 'Save new variations'}
                </Button>
              )}
            </div>
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-md border border-destructive/40 p-4" aria-labelledby="danger-heading">
        <h3 id="danger-heading" className="text-sm font-semibold">
          Archive
        </h3>
        <p className="text-xs text-muted-foreground">
          Archiving removes the flag from listings and stops serving it. History is kept.
          SDKs asking for <code className="font-mono">{flag.key}</code> will fall back to the
          default they pass in, so make sure the code path is gone first.
        </p>
        <Button
          variant="destructive"
          data-testid="archive-flag"
          disabled={!writeGate.allowed}
          title={writeGate.allowed ? undefined : writeGate.reason}
          onClick={() => setArchiveOpen(true)}
        >
          <Archive className="mr-1 h-4 w-4" /> Archive flag
        </Button>
        {!writeGate.allowed && (
          <p className="text-xs text-muted-foreground" data-testid="flag-settings-locked">
            {writeGate.reason}
          </p>
        )}
      </section>

      <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Archive {flag.key}?</AlertDialogTitle>
            <AlertDialogDescription>
              Any SDK still evaluating this flag will get the default value it passes in.
              Confirm the code is gone before archiving.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={archiving}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="archive-confirm"
              disabled={archiving}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                void handleArchive()
              }}
            >
              {archiving ? 'Archiving…' : 'Archive it'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
