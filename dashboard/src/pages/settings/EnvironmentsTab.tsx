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
import { createEnvironment } from '@/lib/projectsApi'
import type { Environment } from '@/types/api'

/** The server's own rule, checked here so the message names the field rather than the pattern. */
const KEY_PATTERN = /^[a-z][a-z0-9-]*$/

/**
 * Environments for the current project.
 *
 * A project is seeded with dev / staging / production, but nothing limits it to those — the
 * schema has no cap and the API has always accepted more. Until this screen existed the only
 * way to add a fourth was curl, which is a strange thing to be true of a management dashboard.
 *
 * Renaming, archiving and deleting are still missing; see docs/REMAINING-WORK.md. That matters
 * because an environment created by mistake is currently permanent and will appear in every
 * environment picker forever, so the create dialog says so rather than letting someone find out.
 */
export function EnvironmentsTab({
  projectId,
  projectName,
  environments,
  canManage,
  onCreated,
}: {
  projectId: string
  projectName: string
  environments: Environment[]
  canManage: boolean
  onCreated: () => Promise<void>
}) {
  const [open, setOpen] = useState(false)
  const [key, setKey] = useState('')
  const [name, setName] = useState('')
  const [creating, setCreating] = useState(false)

  const keyInvalid = key !== '' && !KEY_PATTERN.test(key)
  const duplicate = environments.some((env) => env.key === key)

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
      await onCreated()
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
          Creating an environment needs permission to manage environments. Ask an owner or admin
          — you can still see which exist here.
        </p>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Key</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Change cursor</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {environments.map((environment) => (
              <TableRow key={environment.id} data-testid={`environment-${environment.key}`}>
                <TableCell>
                  <EnvChip envKey={environment.key}>{environment.key}</EnvChip>
                </TableCell>
                <TableCell className="text-sm">{environment.name}</TableCell>
                <TableCell className="text-xs text-muted-foreground">
                  v{environment.stateVersion}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

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
                so it cannot be changed later.
              </p>
              {keyInvalid && (
                <p className="text-xs text-destructive" data-testid="env-key-invalid">
                  Use lower-case letters, numbers and hyphens, starting with a letter.
                </p>
              )}
              {duplicate && (
                <p className="text-xs text-destructive" data-testid="env-key-duplicate">
                  This project already has an environment with that key.
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
            <p className="text-xs text-warning" data-testid="env-permanence-warning">
              There is no way to rename, archive or delete an environment yet, so one created by
              mistake will appear in every environment picker from now on.
            </p>
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
    </section>
  )
}
