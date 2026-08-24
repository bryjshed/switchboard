import { useCallback, useEffect, useState } from 'react'
import { History, RotateCcw } from 'lucide-react'
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
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { EmptyState } from '@/components/EmptyState'
import { listFlagVersions, rollbackFlagEnvConfig } from '@/lib/flagsApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime, formatRelative } from '@/lib/format'
import { queuedWriteToast } from '@/lib/changeRequestDisplay'
import { QueuedForReviewNotice } from '@/components/QueuedForReviewNotice'
import { usePermissionGate } from '@/hooks/usePermissions'
import { cn } from '@/lib/utils'
import type { ApprovalSettings, ChangeRequest, FlagEnvConfig, FlagVersion } from '@/types/api'

export interface HistoryTabProps {
  projectId: string
  flagKey: string
  envKey: string
  /** Live config, so the table can mark which version is currently serving. */
  currentVersion: number
  /** This environment's approval policy: a gated rollback opens a review, not a version. */
  approvals?: ApprovalSettings
  onRolledBack: (config: FlagEnvConfig) => void
}

export function HistoryTab({
  projectId,
  flagKey,
  envKey,
  currentVersion,
  approvals,
  onRolledBack,
}: HistoryTabProps) {
  const { toast } = useToast()
  const rollbackGate = usePermissionGate('FLAG_ROLLBACK')
  const [versions, setVersions] = useState<FlagVersion[]>([])
  const [selected, setSelected] = useState<FlagVersion | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [rollbackTarget, setRollbackTarget] = useState<FlagVersion | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [queued, setQueued] = useState<ChangeRequest | null>(null)

  const gated = approvals?.requireApproval === true

  const load = useCallback(async () => {
    setError(null)
    try {
      const res = await listFlagVersions(projectId, flagKey, envKey, { limit: 50 })
      setVersions(res.items)
      setSelected((prev) => res.items.find((v) => v.versionNumber === prev?.versionNumber) ?? res.items[0] ?? null)
    } catch (err) {
      setError(errorMessage(err, 'Could not load version history'))
    } finally {
      setLoading(false)
    }
  }, [projectId, flagKey, envKey])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load, currentVersion])

  const handleRollback = async () => {
    if (!rollbackTarget) return
    setSubmitting(true)
    setQueued(null)
    try {
      const result = await rollbackFlagEnvConfig(projectId, flagKey, envKey, {
        toVersion: rollbackTarget.versionNumber,
        reason: reason.trim() || undefined,
      })
      if (result.outcome === 'queued') {
        setQueued(result.changeRequest)
        toast(queuedWriteToast(result.changeRequest))
      } else {
        onRolledBack(result.config)
        toast({
          title: `Rolled back to v${rollbackTarget.versionNumber}`,
          description: `Written as new version ${result.config.version}. Nothing in the history was changed.`,
        })
      }
      setRollbackTarget(null)
      setReason('')
      await load()
    } catch (err) {
      toast({ variant: 'destructive', title: 'Rollback failed', description: errorMessage(err) })
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (error) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    )
  }

  if (versions.length === 0) {
    return <EmptyState icon={History} title="No versions yet" />
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1.4fr_1fr]">
      {queued && (
        <div className="lg:col-span-2">
          <QueuedForReviewNotice changeRequest={queued} />
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16">Version</TableHead>
              <TableHead>Note</TableHead>
              <TableHead>State</TableHead>
              <TableHead>Author</TableHead>
              <TableHead className="text-right">When</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {versions.map((version) => {
              const isCurrent = version.versionNumber === currentVersion
              return (
                <TableRow
                  key={version.versionNumber}
                  data-testid={`version-row-${version.versionNumber}`}
                  tabIndex={0}
                  className={cn(
                    'cursor-pointer',
                    selected?.versionNumber === version.versionNumber && 'bg-accent',
                  )}
                  aria-label={`Preview version ${version.versionNumber}`}
                  onClick={() => setSelected(version)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setSelected(version)
                    }
                  }}
                >
                  <TableCell className="font-mono text-sm">
                    v{version.versionNumber}
                    {isCurrent && (
                      <Badge variant="ok" className="ml-1.5 text-[10px]">
                        live
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[220px]">
                    <span className="line-clamp-2 text-sm">{version.versionNote || '—'}</span>
                    {version.createdFromProposalId && (
                      <Badge variant="info" className="mt-1 text-[10px]">
                        from AI proposal
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {version.killSwitchActive ? (
                        <Badge variant="destructive" className="text-[10px]">
                          killed
                        </Badge>
                      ) : version.enabled ? (
                        <Badge variant="ok" className="text-[10px]">
                          on
                        </Badge>
                      ) : (
                        <Badge variant="secondary" className="text-[10px]">
                          off
                        </Badge>
                      )}
                    </div>
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">{version.createdBy}</TableCell>
                  <TableCell className="text-right text-sm" title={version.createdAt}>
                    {formatRelative(version.createdAt)}
                  </TableCell>
                  <TableCell className="text-right">
                    {!isCurrent && rollbackGate.allowed && (
                      <Button
                        size="sm"
                        variant="outline"
                        data-testid={`rollback-${version.versionNumber}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          setRollbackTarget(version)
                        }}
                      >
                        <RotateCcw className="mr-1 h-3 w-3" /> {gated ? 'Request' : 'Roll back'}
                      </Button>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </Table>
      </div>

      <aside className="space-y-2" aria-label="Version preview">
        {!rollbackGate.allowed && (
          <p className="text-xs text-muted-foreground" data-testid="history-rollback-locked">
            {rollbackGate.reason}
          </p>
        )}
        {selected && (
          <>
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold">Version {selected.versionNumber}</h3>
              <span className="text-xs text-muted-foreground">
                {formatDateTime(selected.createdAt)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {selected.versionNote || 'No note'} · by {selected.createdBy}
            </p>
            <pre
              className="max-h-[28rem] overflow-auto rounded-md border bg-muted/40 p-3 text-xs"
              data-testid="version-preview"
            >
              {JSON.stringify(
                {
                  enabled: selected.enabled,
                  killSwitchActive: selected.killSwitchActive,
                  ...selected.config,
                },
                null,
                2,
              )}
            </pre>
          </>
        )}
      </aside>

      <AlertDialog
        open={rollbackTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRollbackTarget(null)
            setReason('')
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {gated ? 'Request a rollback to v' : 'Roll back to v'}
              {rollbackTarget?.versionNumber}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              {gated ? (
                <>
                  {envKey} requires approval, so this opens a change request and changes
                  nothing yet. Once approved, Switchboard copies the v
                  {rollbackTarget?.versionNumber} snapshot into a new version. Nothing in the
                  history is erased either way.
                </>
              ) : (
                <>
                  This does not erase anything. Switchboard copies the v
                  {rollbackTarget?.versionNumber} snapshot into a <strong>new version</strong> (v
                  {currentVersion + 1}) and starts serving it. Everything between stays in the
                  history.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rollback-reason">Reason</Label>
            <Input
              id="rollback-reason"
              data-testid="rollback-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Conversion dropped after the 50% ramp"
              autoFocus
            />
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="rollback-confirm"
              disabled={submitting}
              onClick={(e) => {
                e.preventDefault()
                void handleRollback()
              }}
            >
              {submitting
                ? gated
                  ? 'Submitting…'
                  : 'Rolling back…'
                : gated
                  ? 'Submit for review'
                  : `Create v${currentVersion + 1} from this`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
