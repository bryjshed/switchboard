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
import { createOrg } from '@/lib/orgsApi'
import { useAuth } from '@/hooks/useAuth'
import { useWorkspace } from '@/hooks/useWorkspace'

/**
 * Creates an organization with the caller as its owner, then selects it.
 *
 * Only offered when `profile.canCreateOrg` says the server would allow it: under the
 * `bootstrap` policy that is true for the very first user of an instance and nobody after.
 * The profile is re-read afterwards for exactly that reason — the answer changes once the
 * first org exists.
 */
export function CreateOrgDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { adopt } = useWorkspace()
  const { reloadProfile } = useAuth()
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const close = (next: boolean) => {
    if (busy) return
    if (!next) {
      setName('')
      setError(null)
    }
    onOpenChange(next)
  }

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return
    setBusy(true)
    setError(null)
    try {
      const org = await createOrg({ name: trimmed })
      toast({
        title: `Created ${org.name}`,
        description: 'Next, create a project to hold your flags.',
      })
      setName('')
      onOpenChange(false)
      await adopt(org.id)
      void reloadProfile()
    } catch (err) {
      setError(errorMessage(err, 'Could not create the organization'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent>
        <form onSubmit={(event) => void handleCreate(event)} className="space-y-4">
          <DialogHeader>
            <DialogTitle>New organization</DialogTitle>
            <DialogDescription>
              You become its owner. Invite your team from Settings once it exists.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="org-name">Name</Label>
            <Input
              id="org-name"
              data-testid="org-name"
              placeholder="Acme Inc."
              autoFocus
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="create-org-error">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={() => close(false)}>
              Cancel
            </Button>
            <Button type="submit" data-testid="confirm-create-org" disabled={busy || !name.trim()}>
              {busy ? 'Creating…' : 'Create organization'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
