import { useCallback, useEffect, useState } from 'react'
import { Check, Copy, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime, formatRelative } from '@/lib/format'
import { createMyToken, listMyTokens, revokeMyToken } from '@/lib/tokensApi'
import type { PersonalAccessToken, PersonalAccessTokenCreated } from '@/types/api'

/** Expiry choices. "Never" is offered because CI tokens expiring unattended is its own outage. */
const EXPIRY_OPTIONS = [
  { value: '30', label: '30 days' },
  { value: '90', label: '90 days' },
  { value: '365', label: '1 year' },
  { value: 'never', label: 'No expiry' },
] as const

function expiryToIso(choice: string): string | undefined {
  if (choice === 'never') return undefined
  const days = Number(choice)
  return new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString()
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid="copy-token"
      onClick={() => {
        void navigator.clipboard.writeText(value)
        setCopied(true)
        setTimeout(() => setCopied(false), 1500)
      }}
    >
      {copied ? <Check className="mr-1 h-3 w-3" /> : <Copy className="mr-1 h-3 w-3" />}
      {copied ? 'Copied' : 'Copy'}
    </Button>
  )
}

/**
 * Personal access tokens.
 *
 * Two things this screen has to communicate, because getting either wrong is expensive:
 * the token is shown exactly once, and it carries the full weight of the signed-in person's
 * permissions rather than some lesser subset.
 */
export function TokensTab() {
  const [tokens, setTokens] = useState<PersonalAccessToken[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [name, setName] = useState('')
  const [expiry, setExpiry] = useState<string>('90')
  const [creating, setCreating] = useState(false)
  // Held only until the reveal dialog closes — the backend keeps a hash and will never
  // return the full token again.
  const [revealed, setRevealed] = useState<PersonalAccessTokenCreated | null>(null)
  const [revokeTarget, setRevokeTarget] = useState<PersonalAccessToken | null>(null)
  const [revoking, setRevoking] = useState(false)

  const load = useCallback(async () => {
    setError(null)
    try {
      setTokens(await listMyTokens())
    } catch (err) {
      setError(errorMessage(err, 'Could not load tokens'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const created = await createMyToken({
        name: name.trim(),
        expiresAt: expiryToIso(expiry),
      })
      setRevealed(created)
      setCreateOpen(false)
      setName('')
      setExpiry('90')
      await load()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not create token', description: errorMessage(err) })
    } finally {
      setCreating(false)
    }
  }

  const handleRevoke = async () => {
    if (!revokeTarget) return
    setRevoking(true)
    try {
      await revokeMyToken(revokeTarget.id)
      toast({ title: 'Token revoked' })
      setRevokeTarget(null)
      await load()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not revoke', description: errorMessage(err) })
    } finally {
      setRevoking(false)
    }
  }

  const statusOf = (token: PersonalAccessToken) => {
    if (token.revokedAt) return { label: 'revoked', variant: 'destructive' as const }
    if (token.expiresAt && new Date(token.expiresAt) <= new Date()) {
      return { label: 'expired', variant: 'secondary' as const }
    }
    return { label: 'active', variant: 'default' as const }
  }

  return (
    <section className="space-y-3" aria-label="Personal access tokens">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">Personal access tokens</h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            For scripts, CI and the MCP server — anywhere a browser login will not do. A token acts
            as you and has exactly your permissions, so treat it like your password.
          </p>
        </div>
        <Button size="sm" data-testid="create-token" onClick={() => setCreateOpen(true)}>
          New token
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : tokens.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="tokens-empty">
          No tokens yet.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Token</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Last used</TableHead>
                <TableHead>Expires</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tokens.map((token) => {
                const status = statusOf(token)
                return (
                  <TableRow key={token.id} data-testid={`token-row-${token.id}`}>
                    <TableCell className="text-sm font-medium">{token.name}</TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">
                      {token.tokenPrefix}
                    </TableCell>
                    <TableCell>
                      <Badge variant={status.variant} className="text-[10px]">
                        {status.label}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {/* Never used is worth seeing: it is the safest thing to revoke. */}
                      {token.lastUsedAt ? formatRelative(token.lastUsedAt) : 'never'}
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {token.expiresAt ? formatDateTime(token.expiresAt) : '—'}
                    </TableCell>
                    <TableCell className="text-right">
                      {!token.revokedAt && (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Revoke token ${token.name}`}
                          data-testid={`revoke-token-${token.id}`}
                          onClick={() => setRevokeTarget(token)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New personal access token</DialogTitle>
            <DialogDescription>
              It will act as you, with your permissions. Shown once.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="token-name">Name</Label>
            <Input
              id="token-name"
              data-testid="token-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="ci-deploy"
              autoFocus
            />
            <p className="text-xs text-muted-foreground">
              Required. An unlabelled token is one nobody dares revoke later.
            </p>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="token-expiry">Expires</Label>
            <Select value={expiry} onValueChange={setExpiry}>
              <SelectTrigger id="token-expiry" data-testid="token-expiry">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPIRY_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              disabled={creating || !name.trim()}
              data-testid="token-create-confirm"
              onClick={() => void handleCreate()}
            >
              {creating ? 'Creating…' : 'Create token'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your token now</DialogTitle>
            <DialogDescription>
              This is the only time it will be shown. Switchboard stores a hash and cannot recover
              the value — if you lose it, revoke this token and make another.
            </DialogDescription>
          </DialogHeader>
          <div className="flex items-center gap-2">
            <code
              className="flex-1 overflow-x-auto rounded-md border bg-muted px-3 py-2 font-mono text-xs"
              data-testid="revealed-token"
            >
              {revealed?.token}
            </code>
            {revealed && <CopyButton value={revealed.token} />}
          </div>
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeTarget !== null} onOpenChange={(open) => !open && setRevokeTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Revoke {revokeTarget?.name}?</DialogTitle>
            <DialogDescription>
              Anything using this token stops working immediately. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRevokeTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={revoking}
              data-testid="revoke-token-confirm"
              onClick={() => void handleRevoke()}
            >
              {revoking ? 'Revoking…' : 'Revoke'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
