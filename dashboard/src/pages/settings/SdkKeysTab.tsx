import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, KeyRound, Plus, Trash2, TriangleAlert } from 'lucide-react'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Callout } from '@/components/ui/callout'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { EnvChip } from '@/components/EnvChip'
import { RequirePermission } from '@/components/RequirePermission'
import { usePermissionGate } from '@/hooks/usePermissions'
import { createSdkKey, listSdkKeys, revokeSdkKey } from '@/lib/projectsApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime } from '@/lib/format'
import type { Environment, SdkKey, SdkKeyCreated } from '@/types/api'

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="copy-sdk-key"
      onClick={() => {
        void navigator.clipboard?.writeText(value).then(() => {
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        })
      }}
    >
      {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

function EnvironmentKeys({ environment }: { environment: Environment }) {
  const { toast } = useToast()
  const keyGate = usePermissionGate('MANAGE_SDK_KEYS')
  const [keys, setKeys] = useState<SdkKey[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  // Held only until the reveal dialog closes — the backend stores a hash and will never
  // return the full key again.
  const [revealed, setRevealed] = useState<SdkKeyCreated | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<SdkKey | null>(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setKeys(await listSdkKeys(environment.id))
    } catch (err) {
      setError(errorMessage(err, 'Could not load SDK keys'))
    } finally {
      setLoading(false)
    }
  }, [environment.id])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const created = await createSdkKey(environment.id, { label: label.trim() || undefined })
      setRevealed(created)
      setCreateOpen(false)
      setLabel('')
      await load()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not create key', description: errorMessage(err) })
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await revokeSdkKey(revokeTarget.id)
      toast({ title: `Revoked ${revokeTarget.keyPrefix}` })
      setRevokeTarget(null)
      await load()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Revoke failed', description: errorMessage(err) })
    } finally {
      setRevoking(false)
    }
  }

  const active = keys.filter((k) => !k.revokedAt)

  return (
    <section className="space-y-3" aria-label={`SDK keys for ${environment.key}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <EnvChip envKey={environment.key}>{environment.name}</EnvChip>
          <span className="text-xs text-muted-foreground">
            {active.length} active key{active.length === 1 ? '' : 's'}
          </span>
        </div>
        <RequirePermission permission="MANAGE_SDK_KEYS">
          <Button
            variant="outline"
            size="sm"
            data-testid={`create-sdk-key-${environment.key}`}
            onClick={() => setCreateOpen(true)}
          >
            <Plus className="mr-1 h-3 w-3" /> New key
          </Button>
        </RequirePermission>
      </div>

      {loading ? (
        <Skeleton className="h-20 w-full" />
      ) : error ? (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      ) : keys.length === 0 ? (
        <p className="rounded-md border border-dashed px-4 py-6 text-center text-sm text-muted-foreground">
          No SDK keys in {environment.key}.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Label</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id} data-testid={`sdk-key-row-${key.id}`}>
                  <TableCell className="font-mono text-sm">
                    {/* keyPrefix arrives display-ready, ellipsis included. */}
                    {key.keyPrefix}
                    {key.revokedAt && (
                      <Badge variant="destructive" className="ml-2 text-[10px]">
                        revoked
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{key.label || '—'}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {formatDateTime(key.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {!key.revokedAt && keyGate.allowed && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Revoke key ${key.keyPrefix}`}
                        data-testid={`revoke-sdk-key-${key.id}`}
                        onClick={() => setRevokeTarget(key)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New SDK key for {environment.key}</DialogTitle>
            <DialogDescription>
              Server-side key. It evaluates flags in this environment only.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor={`key-label-${environment.key}`}>Label</Label>
            <Input
              id={`key-label-${environment.key}`}
              data-testid="sdk-key-label"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="checkout-service"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Optional, but a label is how you tell which service to rotate later.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={creating}
              data-testid="sdk-key-create-confirm"
              onClick={() => void handleCreate()}
            >
              {creating ? 'Creating…' : 'Create key'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your key now</DialogTitle>
            <DialogDescription>
              This is the only time Switchboard will show it. Only a hash is stored — close
              this dialog and it is gone for good.
            </DialogDescription>
          </DialogHeader>
          <Callout variant="warning" icon={TriangleAlert}>
            Store it in your secret manager before closing. If you lose it, revoke this key and
            create another.
          </Callout>
          <div className="flex items-center gap-2">
            <code
              className="min-w-0 flex-1 overflow-x-auto rounded-md border bg-muted/40 px-3 py-2 font-mono text-xs"
              data-testid="revealed-sdk-key"
            >
              {revealed?.key}
            </code>
            {revealed && <CopyButton value={revealed.key} />}
          </div>
          <DialogFooter>
            <Button data-testid="sdk-key-reveal-done" onClick={() => setRevealed(null)}>
              I have copied it
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        open={revokeTarget !== null}
        onOpenChange={(open) => !open && setRevokeTarget(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke {revokeTarget?.keyPrefix}?</AlertDialogTitle>
            <AlertDialogDescription>
              Anything still using this key stops evaluating immediately and falls back to the
              defaults its code passes in. This cannot be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoking}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="sdk-key-revoke-confirm"
              disabled={revoking}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                void handleRevoke()
              }}
            >
              {revoking ? 'Revoking…' : 'Revoke'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  )
}

export function SdkKeysTab({ environments }: { environments: readonly Environment[] }) {
  if (environments.length === 0) {
    return (
      <p className="rounded-md border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
        <KeyRound className="mx-auto mb-2 h-5 w-5" aria-hidden />
        Select a project to manage its SDK keys.
      </p>
    )
  }
  return (
    <div className="max-w-3xl space-y-8">
      {environments.map((environment) => (
        <EnvironmentKeys key={environment.id} environment={environment} />
      ))}
    </div>
  )
}
