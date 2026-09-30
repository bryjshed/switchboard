import { useState } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { toast } from '@/components/ui/use-toast'
import { errorMessage } from '@/lib/apiClient'
import { slugify, validateKey } from '@/lib/flagKey'
import { createProject } from '@/lib/projectsApi'
import { useWorkspace } from '@/hooks/useWorkspace'

/**
 * Creates a project in the selected org, then selects it.
 *
 * The server seeds every new project with dev / staging / production and the default metric
 * definitions, so the project is usable the moment this closes — the dialog says so, because
 * otherwise the natural next question is "now how do I add environments?".
 *
 * The key follows the name until it is edited by hand, using the same slugifier as flag keys:
 * project keys obey the same server-side rule.
 */
export function CreateProjectDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { org, adopt } = useWorkspace()
  const [name, setName] = useState('')
  const [key, setKey] = useState('')
  const [keyEdited, setKeyEdited] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const effectiveKey = keyEdited ? key : slugify(name)
  const keyError = effectiveKey || keyEdited ? validateKey(effectiveKey) : null

  const reset = () => {
    setName('')
    setKey('')
    setKeyEdited(false)
    setError(null)
  }

  const close = (next: boolean) => {
    if (busy) return
    if (!next) reset()
    onOpenChange(next)
  }

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!org || !name.trim() || keyError || !effectiveKey) return
    setBusy(true)
    setError(null)
    try {
      const project = await createProject(org.id, { key: effectiveKey, name: name.trim() })
      toast({
        title: `Created ${project.name}`,
        description: 'With dev, staging and production environments.',
      })
      reset()
      onOpenChange(false)
      await adopt(org.id, project.id)
    } catch (err) {
      setError(errorMessage(err, 'Could not create the project'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={(event) => void handleCreate(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New project</DialogTitle>
            <DialogDescription>
              A project holds a set of flags{org ? ` in ${org.name}` : ''}. Dev, staging and
              production are created for you.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              data-testid="project-name"
              placeholder="Storefront"
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="project-key">Key</Label>
            <Input
              id="project-key"
              data-testid="project-key"
              placeholder="storefront"
              value={effectiveKey}
              onChange={(event) => {
                setKeyEdited(true)
                setKey(event.target.value)
              }}
            />
            <p className="text-xs text-muted-foreground">
              What the API and SDKs refer to. It cannot be changed later — the name can.
            </p>
            {keyError && (
              <p className="text-xs text-destructive" data-testid="project-key-invalid">
                {keyError}
              </p>
            )}
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="create-project-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button
              type="submit"
              data-testid="confirm-create-project"
              disabled={busy || !org || !name.trim() || !effectiveKey || keyError !== null}
            >
              {busy ? 'Creating…' : 'Create project'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
