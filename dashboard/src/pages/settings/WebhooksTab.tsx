import { Fragment, useCallback, useEffect, useState } from 'react'
import { Check, ChevronDown, ChevronRight, Copy, Trash2 } from 'lucide-react'
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
import { Switch } from '@/components/ui/switch'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { toast } from '@/components/ui/use-toast'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime, formatRelative } from '@/lib/format'
import {
  createWebhook,
  deleteWebhook,
  listWebhookDeliveries,
  listWebhooks,
  updateWebhook,
} from '@/lib/webhooksApi'
import type { Webhook, WebhookCreated, WebhookDelivery, WebhookEventType } from '@/types/api'

/**
 * Every event type, with the wire name the API speaks and a description in the operator's
 * terms rather than the schema's. Kill switches and rollbacks are separate from ordinary
 * updates because those are the two people actually want to alert on.
 */
const EVENT_TYPES: ReadonlyArray<{ value: WebhookEventType; label: string; hint: string }> = [
  { value: 'flag.updated', label: 'Flag updated', hint: 'Targeting or a rollout weight changed' },
  { value: 'flag.kill_switch', label: 'Kill switch', hint: 'Engaged or released' },
  { value: 'flag.rollback', label: 'Rollback', hint: 'A configuration was rolled back' },
  { value: 'rollout.finding', label: 'Monitor finding', hint: 'The AI layer raised something' },
]

function CopyButton({ value, testId }: { value: string; testId: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      data-testid={testId}
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

function deliveryVariant(status: WebhookDelivery['status']) {
  if (status === 'DELIVERED') return 'default' as const
  if (status === 'FAILED') return 'destructive' as const
  return 'secondary' as const
}

/** Recent attempts for one webhook, loaded only when the row is expanded. */
function Deliveries({ webhookId }: { webhookId: string }) {
  const [deliveries, setDeliveries] = useState<WebhookDelivery[] | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    listWebhookDeliveries(webhookId)
      .then((rows) => {
        if (!cancelled) setDeliveries(rows)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorMessage(err, 'Could not load deliveries'))
      })
    return () => {
      cancelled = true
    }
  }, [webhookId])

  if (error) return <p className="p-3 text-xs text-destructive">{error}</p>
  if (!deliveries) return <p className="p-3 text-xs text-muted-foreground">Loading deliveries…</p>
  if (deliveries.length === 0) {
    return (
      <p className="p-3 text-xs text-muted-foreground" data-testid="deliveries-empty">
        Nothing delivered yet. A flag change in this org will produce one.
      </p>
    )
  }

  return (
    <div className="space-y-1 p-3" data-testid="deliveries">
      {deliveries.map((delivery) => (
        <div key={delivery.id} className="flex items-center gap-3 text-xs">
          <Badge variant={deliveryVariant(delivery.status)}>{delivery.status.toLowerCase()}</Badge>
          <span className="font-mono">{delivery.eventType}</span>
          <span className="text-muted-foreground">{formatRelative(delivery.createdAt)}</span>
          <span className="text-muted-foreground">
            {delivery.attempts} {delivery.attempts === 1 ? 'attempt' : 'attempts'}
            {delivery.responseStatus ? ` · HTTP ${delivery.responseStatus}` : ''}
          </span>
          {delivery.error && (
            <span className="truncate text-destructive" title={delivery.error}>
              {delivery.error}
            </span>
          )}
        </div>
      ))}
    </div>
  )
}

/**
 * Signed outbound webhooks.
 *
 * Two things this screen exists to communicate, because both are expensive to get wrong: the
 * signing secret is shown exactly once, and an empty event-type selection means EVERY event
 * rather than none — the opposite reading would make a new webhook look broken.
 */
export function WebhooksTab({ orgId }: { orgId: string }) {
  const [webhooks, setWebhooks] = useState<Webhook[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [description, setDescription] = useState('')
  const [selectedTypes, setSelectedTypes] = useState<WebhookEventType[]>([])
  const [creating, setCreating] = useState(false)
  // Held only until the reveal dialog closes. The API returns the secret exactly once.
  const [revealed, setRevealed] = useState<WebhookCreated | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<Webhook | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      setWebhooks(await listWebhooks(orgId))
    } catch (err) {
      setError(errorMessage(err, 'Could not load webhooks'))
    } finally {
      setLoading(false)
    }
  }, [orgId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  const handleCreate = async () => {
    setCreating(true)
    try {
      const created = await createWebhook(orgId, {
        url: url.trim(),
        description: description.trim() || undefined,
        // Empty means every type, which is what the API reads it as.
        eventTypes: selectedTypes.length > 0 ? selectedTypes : undefined,
      })
      setRevealed(created)
      setCreateOpen(false)
      setUrl('')
      setDescription('')
      setSelectedTypes([])
      await load()
    } catch (err) {
      toast({
        variant: 'destructive',
        title: 'Could not create webhook',
        description: errorMessage(err),
      })
    } finally {
      setCreating(false)
    }
  }

  const handleToggle = async (webhook: Webhook) => {
    try {
      await updateWebhook(webhook.id, { enabled: !webhook.enabled })
      toast({ title: webhook.enabled ? 'Webhook disabled' : 'Webhook enabled' })
      await load()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not update', description: errorMessage(err) })
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    try {
      await deleteWebhook(deleteTarget.id)
      toast({ title: 'Webhook deleted' })
      setDeleteTarget(null)
      await load()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Could not delete', description: errorMessage(err) })
    } finally {
      setDeleting(false)
    }
  }

  const toggleType = (type: WebhookEventType) =>
    setSelectedTypes((current) =>
      current.includes(type) ? current.filter((t) => t !== type) : [...current, type],
    )

  return (
    <section className="space-y-3" aria-label="Webhooks">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">Webhooks</h3>
          <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
            Signed with HMAC-SHA256 and retried with backoff. Verify the{' '}
            <code className="font-mono">X-Switchboard-Signature</code> header before trusting a
            delivery — the timestamp is inside the signature, so a captured request cannot be
            replayed later.
          </p>
        </div>
        <Button size="sm" data-testid="create-webhook" onClick={() => setCreateOpen(true)}>
          New webhook
        </Button>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {loading ? (
        <p className="text-sm text-muted-foreground">Loading…</p>
      ) : error ? (
        // Nothing else. "Could not load webhooks" above an empty state tells the operator two
        // contradictory things, and the one they will believe - "I have no webhooks" - is the
        // dangerous reading: it looks like nothing is configured rather than like nothing is
        // known. An unreadable list is not an empty list.
        null
      ) : webhooks.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="webhooks-empty">
          No webhooks yet.
        </p>
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>URL</TableHead>
                <TableHead>Events</TableHead>
                <TableHead>Enabled</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-16" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {webhooks.map((webhook) => (
                // Fragment carries the key, not the rows inside it: a webhook renders as one
                // or two <tr> elements and the LIST item is the pair. Keying the inner rows
                // instead leaves the fragment unkeyed, which is a React warning and, worse,
                // lets reconciliation reuse the wrong expanded row when one is deleted.
                <Fragment key={webhook.id}>
                  <TableRow data-testid={`webhook-${webhook.id}`}>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label={expanded === webhook.id ? 'Hide deliveries' : 'Show deliveries'}
                        data-testid={`expand-${webhook.id}`}
                        onClick={() => setExpanded(expanded === webhook.id ? null : webhook.id)}
                      >
                        {expanded === webhook.id ? (
                          <ChevronDown className="h-4 w-4" />
                        ) : (
                          <ChevronRight className="h-4 w-4" />
                        )}
                      </Button>
                    </TableCell>
                    <TableCell className="max-w-xs truncate font-mono text-xs" title={webhook.url}>
                      {webhook.url}
                      {webhook.description && (
                        <span className="block truncate font-sans text-muted-foreground">
                          {webhook.description}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-xs">
                      {webhook.eventTypes.length === 0 ? (
                        <span className="text-muted-foreground">All events</span>
                      ) : (
                        webhook.eventTypes.join(', ')
                      )}
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={webhook.enabled}
                        aria-label="Enabled"
                        data-testid={`toggle-${webhook.id}`}
                        onCheckedChange={() => void handleToggle(webhook)}
                      />
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">
                      {formatDateTime(webhook.createdAt)}
                    </TableCell>
                    <TableCell>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        aria-label="Delete webhook"
                        data-testid={`delete-${webhook.id}`}
                        onClick={() => setDeleteTarget(webhook)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </TableCell>
                  </TableRow>
                  {expanded === webhook.id && (
                    <TableRow>
                      <TableCell colSpan={6} className="bg-muted/40 p-0">
                        <Deliveries webhookId={webhook.id} />
                      </TableCell>
                    </TableRow>
                  )}
                </Fragment>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>New webhook</DialogTitle>
            <DialogDescription>
              Switchboard will POST signed JSON here. The signing secret is shown once, right
              after this.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="webhook-url">Endpoint URL</Label>
              <Input
                id="webhook-url"
                data-testid="webhook-url"
                placeholder="https://example.com/hooks/switchboard"
                value={url}
                onChange={(event) => setUrl(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="webhook-description">Description (optional)</Label>
              <Input
                id="webhook-description"
                data-testid="webhook-description"
                placeholder="Slack relay"
                value={description}
                onChange={(event) => setDescription(event.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label>Events</Label>
              <div className="space-y-2">
                {EVENT_TYPES.map((type) => (
                  <label key={type.value} className="flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1"
                      data-testid={`event-${type.value}`}
                      checked={selectedTypes.includes(type.value)}
                      onChange={() => toggleType(type.value)}
                    />
                    <span>
                      {type.label}
                      <span className="block text-xs text-muted-foreground">{type.hint}</span>
                    </span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">
                Select none to receive every event, including any added later.
              </p>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setCreateOpen(false)}>
              Cancel
            </Button>
            <Button
              data-testid="confirm-create-webhook"
              disabled={creating || url.trim() === ''}
              onClick={() => void handleCreate()}
            >
              {creating ? 'Creating…' : 'Create webhook'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revealed !== null} onOpenChange={(open) => !open && setRevealed(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Copy your signing secret</DialogTitle>
            <DialogDescription>
              This is the only time it is shown. Without it you cannot verify that a delivery
              came from Switchboard.
            </DialogDescription>
          </DialogHeader>
          {revealed && (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <code
                  className="flex-1 truncate rounded bg-muted px-2 py-1 font-mono text-xs"
                  data-testid="revealed-secret"
                >
                  {revealed.secret}
                </code>
                <CopyButton value={revealed.secret} testId="copy-secret" />
              </div>
              <p className="text-xs text-muted-foreground">
                Verify each delivery by computing{' '}
                <code className="font-mono">HMAC-SHA256(secret, "&lt;t&gt;.&lt;raw body&gt;")</code>{' '}
                and comparing it to the <code className="font-mono">v1=</code> value in the
                signature header, in constant time. Reject anything whose{' '}
                <code className="font-mono">t</code> is far from now.
              </p>
            </div>
          )}
          <DialogFooter>
            <Button onClick={() => setRevealed(null)}>Done</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(open) => !open && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this webhook?</DialogTitle>
            <DialogDescription>
              Deliveries stop immediately and its history goes with it. To pause instead, switch
              it off — that keeps the endpoint and its delivery record.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              data-testid="confirm-delete-webhook"
              disabled={deleting}
              onClick={() => void handleDelete()}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
