import { useCallback, useEffect, useState } from 'react'
import { Plus, Trash2, Users2 } from 'lucide-react'
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
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useToast } from '@/components/ui/use-toast'
import { PageHeading } from '@/components/layout/PageHeading'
import { EmptyState } from '@/components/EmptyState'
import { SegmentDialog } from './segments/SegmentDialog'
import { deleteSegment, listSegments } from '@/lib/segmentsApi'
import { ApiClientError, errorMessage } from '@/lib/apiClient'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { Segment } from '@/types/api'

export function SegmentsPage() {
  const segmentGate = usePermissionGate('SEGMENT_WRITE')
  const { toast } = useToast()
  const { project, loading: workspaceLoading } = useWorkspace()
  const [segments, setSegments] = useState<Segment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState<Segment | null>(null)
  const [dialogOpen, setDialogOpen] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<Segment | null>(null)
  const [deleting, setDeleting] = useState(false)
  // A 409 here means a flag rule still points at this segment. That is a real protection, so
  // the backend's message is shown inside the confirm dialog rather than flashed past as a
  // toast. It does not name the offending flags, so the copy does not promise that.
  const [deleteError, setDeleteError] = useState<string | null>(null)

  const load = useCallback(async (projectId: string) => {
    setError(null)
    try {
      setSegments(await listSegments(projectId))
    } catch (err) {
      setError(errorMessage(err, 'Could not load segments'))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!project) {
      if (!workspaceLoading) setLoading(false)
      return
    }
    setLoading(true)
    void load(project.id)
  }, [project, workspaceLoading, load])

  const handleDelete = async () => {
    if (!deleteTarget || !project) return
    setDeleting(true)
    setDeleteError(null)
    try {
      await deleteSegment(project.id, deleteTarget.key)
      toast({ title: `Deleted ${deleteTarget.key}` })
      setDeleteTarget(null)
      await load(project.id)
    } catch (err) {
      if (err instanceof ApiClientError && err.status === 409) {
        setDeleteError(err.message)
      } else {
        setDeleteError(errorMessage(err, 'Could not delete this segment'))
      }
    } finally {
      setDeleting(false)
    }
  }

  if (!workspaceLoading && !project) {
    return (
      <div className="space-y-6">
        <PageHeading title="Segments" />
        <EmptyState icon={Users2} title="No project selected" />
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <PageHeading
          title="Segments"
          description="Reusable audiences. Flag rules reference them by key, so one edit here changes every rule that uses it."
        />
        <Button
          data-testid="new-segment"
          disabled={!project || !segmentGate.allowed}
          title={segmentGate.allowed ? undefined : segmentGate.reason}
          onClick={() => {
            setEditing(null)
            setDialogOpen(true)
          }}
        >
          <Plus className="mr-1 h-4 w-4" /> New segment
        </Button>
      </div>

      {error && (
        <p className="text-sm text-destructive" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-12 w-full" />
          ))}
        </div>
      ) : segments.length === 0 ? (
        <EmptyState
          icon={Users2}
          title="No segments yet"
          description="Define an audience once — beta testers, enterprise accounts — and target it from any flag."
        />
      ) : (
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Segment</TableHead>
                <TableHead>Included</TableHead>
                <TableHead>Excluded</TableHead>
                <TableHead>Rules</TableHead>
                <TableHead className="w-24" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {segments.map((segment) => (
                <TableRow
                  key={segment.id}
                  data-testid={`segment-row-${segment.key}`}
                  tabIndex={0}
                  className="cursor-pointer"
                  aria-label={`Edit ${segment.name}`}
                  onClick={() => {
                    setEditing(segment)
                    setDialogOpen(true)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setEditing(segment)
                      setDialogOpen(true)
                    }
                  }}
                >
                  <TableCell>
                    <div className="font-mono text-sm">{segment.key}</div>
                    <div className="text-xs text-muted-foreground">{segment.name}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{segment.includedKeys.length}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{segment.excludedKeys.length}</Badge>
                  </TableCell>
                  <TableCell>
                    <Badge variant="outline">{segment.rules.length}</Badge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={`Delete ${segment.key}`}
                      data-testid={`delete-segment-${segment.key}`}
                      disabled={!segmentGate.allowed}
                      title={segmentGate.allowed ? undefined : segmentGate.reason}
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteError(null)
                        setDeleteTarget(segment)
                      }}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {project && (
        <SegmentDialog
          projectId={project.id}
          segment={editing}
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          onSaved={() => void load(project.id)}
        />
      )}

      <AlertDialog
        open={deleteTarget !== null}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
            setDeleteError(null)
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {deleteTarget?.key}?</AlertDialogTitle>
            <AlertDialogDescription>
              Any flag rule that targets this segment must be changed first. Switchboard
              refuses the delete while a rule still references it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {deleteError && (
            <p
              className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
              role="alert"
              data-testid="segment-delete-error"
            >
              {deleteError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={deleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              data-testid="segment-delete-confirm"
              disabled={deleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={(e) => {
                e.preventDefault()
                void handleDelete()
              }}
            >
              {deleting ? 'Deleting…' : 'Delete'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
