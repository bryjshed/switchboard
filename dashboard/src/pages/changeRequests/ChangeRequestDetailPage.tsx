import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, Check, ExternalLink, Quote, TriangleAlert, X } from 'lucide-react'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { EnvChip } from '@/components/EnvChip'
import { DiffPreview } from '@/pages/ai/DiffPreview'
import { getChangeRequest } from '@/lib/changeRequestsApi'
import { getFlag, getFlagVersion } from '@/lib/flagsApi'
import { getMyPermissions } from '@/lib/accessApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime, formatRelative } from '@/lib/format'
import {
  changeRequestStatusMeta,
  changeRequestToDiff,
  describeApprovalProgress,
} from '@/lib/changeRequestDisplay'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { ChangeRequest, FlagDetail, FlagVersion, Permission } from '@/types/api'
import { ChangeRequestActions } from './ChangeRequestActions'
import {
  ApprovalProgress,
  ChangeRequestKindBadge,
  ChangeRequestStatusBadge,
} from './changeRequestBadges'

/**
 * One change request, as a reviewer needs to read it: who asked, why, what it would actually
 * do to the flag, who has signed it off so far, and the buttons — only the ones that will
 * work.
 *
 * The diff is the point of the page. A reviewer approving a production rollout must be
 * reading "Fallthrough 100% Control → 50% Control / 50% Variant", not a JSON blob, so the
 * payload is adapted into the same `DiffPreview` the AI proposals use, against the flag's
 * current config so every line reads before → after.
 */
export function ChangeRequestDetailPage() {
  const { changeRequestId = '' } = useParams()
  const { selectEnvironment } = useWorkspace()

  const [cr, setCr] = useState<ChangeRequest | null>(null)
  const [flag, setFlag] = useState<FlagDetail | null>(null)
  const [rollbackSnapshot, setRollbackSnapshot] = useState<FlagVersion | null>(null)
  const [permissions, setPermissions] = useState<ReadonlySet<Permission> | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const next = await getChangeRequest(changeRequestId)
      setCr(next)
      setDetailLoading(true)
      // All three are best-effort: a request whose flag was archived, or a scope lookup that
      // fails, must still render the request rather than blanking the page.
      const [detail, perms, snapshot] = await Promise.all([
        getFlag(next.projectId, next.flagKey).catch(() => null),
        // Scoped to THIS request's environment, not the workspace's selected one — the
        // buttons must reflect where the change would land.
        getMyPermissions({ envId: next.environmentId }).catch(() => null),
        next.kind === 'ROLLBACK' && next.payload.toVersion != null
          ? getFlagVersion(next.projectId, next.flagKey, next.envKey, next.payload.toVersion).catch(
              () => null,
            )
          : Promise.resolve(null),
      ])
      setFlag(detail)
      setPermissions(perms ? new Set(perms.permissions) : new Set())
      setRollbackSnapshot(snapshot)
    } catch (err) {
      setError(errorMessage(err, 'Could not load this change request'))
    } finally {
      setLoading(false)
      setDetailLoading(false)
    }
  }, [changeRequestId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error || !cr) {
    return (
      <div className="space-y-4">
        <BackLink />
        <p className="text-sm text-destructive" role="alert">
          {error ?? 'Change request not found'}
        </p>
      </div>
    )
  }

  const meta = changeRequestStatusMeta(cr.status)
  const flagLink = `/flags/${encodeURIComponent(cr.flagKey)}`
  const diff = changeRequestToDiff(cr, rollbackSnapshot)

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <BackLink />
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <span className="font-mono text-xl font-bold tracking-tight">{cr.flagKey}</span>
          <EnvChip envKey={cr.envKey} />
          <ChangeRequestKindBadge kind={cr.kind} />
          <ChangeRequestStatusBadge status={cr.status} />
        </div>
        <p className="mt-2 text-sm text-muted-foreground" data-testid="cr-requested-by">
          Requested by <span className="font-mono">{cr.requestedBy}</span>{' '}
          <span title={formatDateTime(cr.createdAt)}>{formatRelative(cr.createdAt)}</span>, against
          version {cr.baseVersion}.
        </p>
        <p className="mt-1 text-sm text-muted-foreground">
          <ApprovalProgress changeRequest={cr} />{' '}
          <span data-testid="cr-progress-long">· {describeApprovalProgress(cr)}</span>
        </p>
      </div>

      {cr.status === 'STALE' ? (
        <Callout variant="warning" icon={TriangleAlert} data-testid="cr-stale-banner">
          <p className="font-medium text-warning-foreground">
            {cr.flagKey} moved on while this was waiting
          </p>
          <p>
            This request was written against version {cr.baseVersion}, and {cr.envKey} is past
            that now. Switchboard refused it rather than overwrite the newer version, so nothing
            was applied and nothing was lost. To make this change, open {cr.flagKey} in{' '}
            {cr.envKey}, re-apply your edit on top of what is there now, and submit a fresh
            request.
          </p>
        </Callout>
      ) : (
        <Callout
          variant={cr.status === 'DECLINED' ? 'danger' : 'info'}
          data-testid="cr-status-note"
        >
          {meta.description}
        </Callout>
      )}

      {cr.comment?.trim() && (
        <blockquote
          className="flex gap-2 rounded-md border-l-2 border-border bg-muted/40 py-2 pl-3 pr-4 text-sm"
          data-testid="cr-comment-quote"
        >
          <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>{cr.comment}</span>
        </blockquote>
      )}

      <section className="space-y-2" aria-labelledby="cr-diff-heading">
        <h3 id="cr-diff-heading" className="text-sm font-semibold">
          What this would change
        </h3>
        <DiffPreview
          diff={diff}
          flag={flag}
          flagLoading={detailLoading}
          heading={
            <>
              <ChangeRequestKindBadge kind={cr.kind} />
              <span className="font-mono text-sm font-medium">{cr.flagKey}</span>
              <EnvChip envKey={cr.envKey} />
            </>
          }
        />
        {cr.kind === 'ROLLBACK' && !rollbackSnapshot && !detailLoading && (
          <p className="text-xs text-muted-foreground" data-testid="cr-rollback-snapshot-missing">
            The v{cr.payload.toVersion} snapshot could not be loaded, so only the target version
            is shown. Open the flag's History tab to read it before approving.
          </p>
        )}
      </section>

      <section className="space-y-2" aria-labelledby="cr-reviews-heading">
        <h3 id="cr-reviews-heading" className="text-sm font-semibold">
          Reviews
        </h3>
        {cr.reviews.length === 0 ? (
          <p className="text-sm text-muted-foreground" data-testid="cr-no-reviews">
            Nobody has reviewed this yet.
          </p>
        ) : (
          <ul className="space-y-2" data-testid="cr-reviews">
            {cr.reviews.map((review) => {
              const approved = review.decision === 'APPROVE'
              const Icon = approved ? Check : X
              return (
                <li
                  key={review.id}
                  className={cn(
                    'flex items-start gap-3 rounded-md border p-3',
                    approved ? 'border-ok/40 bg-ok/5' : 'border-destructive/40 bg-destructive/5',
                  )}
                  data-testid={`cr-review-${review.id}`}
                >
                  <Icon
                    className={cn(
                      'mt-0.5 h-4 w-4 shrink-0',
                      approved ? 'text-ok-foreground' : 'text-destructive',
                    )}
                    aria-hidden
                  />
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">
                      <span className="font-mono">{review.reviewer}</span>{' '}
                      {approved ? 'approved' : 'declined'}{' '}
                      <span className="text-muted-foreground" title={formatDateTime(review.createdAt)}>
                        {formatRelative(review.createdAt)}
                      </span>
                    </p>
                    {review.comment?.trim() && (
                      <p className="mt-1 text-sm text-muted-foreground">{review.comment}</p>
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <ChangeRequestActions
        changeRequest={cr}
        permissions={permissions}
        onChanged={setCr}
        onRefresh={() => void load()}
      />

      <Link
        to={cr.status === 'APPLIED' ? `${flagLink}?tab=history` : flagLink}
        data-testid="cr-open-flag"
        onClick={() => selectEnvironment(cr.envKey)}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        {cr.status === 'APPLIED' && cr.appliedVersion != null
          ? `Open version ${cr.appliedVersion} in ${cr.flagKey}'s history`
          : `Open ${cr.flagKey} in ${cr.envKey}`}
        <ExternalLink className="h-3 w-3" aria-hidden />
      </Link>
    </div>
  )
}

function BackLink() {
  return (
    <Link
      to="/change-requests"
      data-testid="back-to-change-requests"
      className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
    >
      <ArrowLeft className="mr-1 h-4 w-4" /> Change requests
    </Link>
  )
}
