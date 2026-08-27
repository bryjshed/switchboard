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
import { EnvChip } from '@/components/EnvChip'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import { errorMessage } from '@/lib/apiClient'
import { createEnvironment, updateEnvironment } from '@/lib/projectsApi'
import type { Environment } from '@/types/api'

/** The server's own rule, checked here so the message names the field rather than the pattern. */
const KEY_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Environments for the current project: list, create, rename, archive, restore.
 *
 * A project is seeded with dev / staging / production, but nothing limits it to those — the
 * schema has no cap and the API has always accepted more. Until this screen existed the only way
 * to add a fourth was curl, which is a strange thing to be true of a management dashboard.
 *
 * **Archiving is not deleting, and the difference is worth showing rather than hiding.** An
 * archived environment disappears from the environment picker and can no longer be edited, but it
 * keeps serving: anything still holding one of its SDK keys evaluates exactly as before. So this
 * screen keeps archived environments visible in their own section, says how many keys are still
 * live on them, and offers restore. Deleting outright is not offered at all — the version history
 * and audit trail hanging off an environment are the record of what it served.
 */
export function EnvironmentsTab({
  projectId,
  projectName,
  environments,
  canManage,
  onChanged,
}: {
  projectId: string
  projectName: string
  environments: Environment[]
  canManage: boolean
  onChanged: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)
  const [renaming, setRenaming] = useState<Environment | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [archiving, setArchiving] = useState<Environment | null>(null)
  const [busy, setBusy] = useState(false)

  const active = environments.filter((env) => !env.archivedAt)
  const archived = environments.filter((env) => env.archivedAt)

  const keyInvalid = key !== '' && !KEY_PATTERN.test(key)
  const duplicate = environments.some((env) => env.key === key)
  // The key stays reserved by an archived environment, so this case gets its own message —
  // "already exists" is confusing when the environment is not in the list above.
  const duplicateArchived = archived.some((env) => env.key === key)
  const lastActive = active.length <= 1

  const handleCreate = async () => {
    setCreating(true)
    try {
      await createEnvironment(projectId, { key: key.trim(), name: name.trim() || key.trim() })
      toast({ title: `Created ${key.trim()}` })
      setOpen(false)
      setKey('')
      setName('')
      // The environment picker and every per-environment screen read from the workspace, so
      // a new environment is invisible until this reloads it.
      await onChanged()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not create environment',
        description: errorMessage(err),
      })
    } finally {
      setCreating(false)
    }
  }

  const handleRename = async () => {
    if (!renaming) return
    setBusy(true)
    try {
      await updateEnvironment(renaming.id, { name: renameValue.trim() })
      toast({ title: `Renamed to ${renameValue.trim()}` })
      setRenaming(null)
      await onChanged()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not rename', description: errorMessage(err) })
    } finally {
      setBusy(false)
    }
  }

  const handleSetArchived = async (environment: Environment, archive: boolean) => {
    setBusy(true)
    try {
      await updateEnvironment(environment.id, { archived: archive })
      toast({ title: archive ? `Archived ${environment.key}` : `Restored ${environment.key}` })
      setArchiving(null)
      await onChanged()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: archive ? 'Could not archive' : 'Could not restore',
        description: errorMessage(err),
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-3" aria-label="Environments">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">Environments in {projectName}</h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Every flag gets a configuration in each of these, evaluated independently. A project
            starts with three; there is no limit.
          </p>
        </div>
        <Button
          size="sm"
          data-testid="create-environment"
          disabled={!canManage}
          onClick={() => setOpen(true)}
        >
          New environment
        </Button>
      </div>

      {!canManage && (
        <p className="text-xs text-muted-foreground" data-testid="environments-readonly">
          Changing environments needs permission to manage environments. Ask an owner or admin —
          you can still see which exist here.
        </p>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Change cursor</TableHead>
              <TableHead className="w-[1%]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {active.map((environment) => (
              <TableRow key={environment.id} data-testid={`environment-${environment.key}`}>
                <TableCell>
                  <EnvChip envKey={environment.key}>{environment.key}</EnvChip>
                </TableCell>
                <TableCell className="text-sm">{environment.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  v{environment.stateVersion}
                </TableCell>
                <TableCell className="whitespace-nowrap text-right">
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={!canManage}
                    data-testid={`rename-${environment.key}`}
                    onClick={() => {
                      setRenaming(environment)
                      setRenameValue(environment.name)
                    }}
                  >
                    Rename
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    // A project with no active environments has an empty picker and no way
                    // back through the UI. The server refuses this too.
                    disabled={!canManage || lastActive}
                    title={lastActive ? "This is the project's only active environment" : undefined}
                    data-testid={`archive-${environment.key}`}
                    onClick={() => setArchiving(environment)}
                  >
                    Archive
                  </Button>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {archived.length > 0 && (
        <div className="space-y-2" data-testid="archived-environments">
          <h4 className="text-xs font-medium text-muted-foreground">Archived</h4>
          <p className="max-w-2xl text-xs text-muted-foreground">
            Hidden from the environment picker and frozen against config changes.{' '}
            <strong className="font-medium text-warning">These still serve.</strong> Any SDK key
            pointed at one keeps evaluating, and the kill switch keeps working, so archiving
            cannot take an environment down by accident.
          </p>
          <div className="rounded-md border">
            <Table>
              <TableBody>
                {archived.map((environment) => (
                  <TableRow
                    key={environment.id}
                    data-testid={`archived-environment-${environment.key}`}
                  >
                    <TableCell className="text-sm text-muted-foreground">
                      {environment.key}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {environment.name}
                    </TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={!canManage || busy}
                        data-testid={`restore-${environment.key}`}
                        onClick={() => void handleSetArchived(environment, false)}
                      >
                        Restore
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New environment</DialogTitle>
            <DialogDescription>
              Every existing flag gets a configuration in it, switched off, at version 1.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="env-key">Key</Label>
              <Input
                id="env-key"
                data-testid="env-key"
                placeholder="staging-eu"
                value={key}
                onChange={(event) => setKey(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">
                Lower-case, starting with a letter. This is what SDK keys and the API refer to,
                so it cannot be changed later — the name can.
              </p>
              {keyInvalid && (
                <p className="text-xs text-destructive" data-testid="env-key-invalid">
                  Use lower-case letters, numbers and hyphens, starting with a letter.
                </p>
              )}
              {duplicate && !duplicateArchived && (
                <p className="text-xs text-destructive" data-testid="env-key-duplicate">
                  This project already has an environment with that key.
                </p>
              )}
              {duplicateArchived && (
                <p className="text-xs text-destructive" data-testid="env-key-archived">
                  An archived environment already holds that key. Restore it instead — it still
                  has its flag configs and history.
                </p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="env-name">Name (optional)</Label>
              <Input
                id="env-name"
                data-testid="env-name"
                placeholder="Staging (EU)"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              data-testid="confirm-create-environment"
              disabled={creating || key.trim() === '' || keyInvalid || duplicate}
              onClick={() => void handleCreate()}
            >
              {creating ? 'Creating…' : 'Create environment'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={renaming !== null} onOpenChange={(next) => !next && setRenaming(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rename {renaming?.key}</DialogTitle>
            <DialogDescription>
              The display name only. The key stays <code>{renaming?.key}</code> — SDK keys, saved
              links and the audit trail all refer to it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <Label htmlFor="env-rename">Name</Label>
            <Input
              id="env-rename"
              data-testid="env-rename"
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRenaming(null)}>
              Cancel
            </Button>
            <Button
              data-testid="confirm-rename"
              disabled={busy || renameValue.trim() === ''}
              onClick={() => void handleRename()}
            >
              {busy ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={archiving !== null} onOpenChange={(next) => !next && setArchiving(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive {archiving?.key}?</DialogTitle>
            <DialogDescription>
              It disappears from the environment picker and its flag configs can no longer be
              changed. You can restore it here afterwards.
            </DialogDescription>
          </DialogHeader>
          <p className="text-xs text-warning" data-testid="archive-still-serves-warning">
            It keeps serving. Any SDK key pointed at {archiving?.key} evaluates exactly as it does
            now — archiving tidies the dashboard, it does not turn the environment off. Revoke its
            SDK keys if that is what you meant.
          </p>
          <DialogFooter>
            <Button variant="outline" onClick={() => setArchiving(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="confirm-archive"
              disabled={busy}
              onClick={() => archiving && void handleSetArchived(archiving, true)}
            >
              {busy ? 'Archiving…' : 'Archive'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
