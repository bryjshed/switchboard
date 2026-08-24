import type {
  ChangeRequest,
  ChangeRequestKind,
  ChangeRequestStatus,
  FlagChangeDiff,
  FlagVersion,
  Permission,
} from '@/types/api'

/**
 * Everything a change request has to say about itself in words, kept out of the components
 * so the list row, the detail header and the toast after a 202 all describe the same request
 * identically — and so the awkward parts (approval arithmetic, who may press which button)
 * are unit-testable without rendering anything.
 */

export const CHANGE_REQUEST_KIND_LABELS: Record<ChangeRequestKind, string> = {
  TARGETING_UPDATE: 'targeting update',
  KILL_SWITCH: 'kill switch',
  ROLLBACK: 'rollback',
}

export type StatusVariant = 'info' | 'ok' | 'warning' | 'destructive' | 'secondary' | 'outline'

export interface StatusMeta {
  label: string
  variant: StatusVariant
  /** One line for the detail header: what this status means for the flag. */
  description: string
  /** True while the request can still be approved or declined. */
  reviewable: boolean
}

/**
 * STALE and DECLINED must not read like PENDING at a glance — one needs recreating, the
 * other is over, and both are easy to mistake for "still waiting" if they share a tint.
 * PENDING is info (an invitation), STALE is warning (it needs you), DECLINED is
 * destructive (it was refused), and the settled states are muted.
 */
export const CHANGE_REQUEST_STATUS_META: Record<ChangeRequestStatus, StatusMeta> = {
  PENDING: {
    label: 'awaiting review',
    variant: 'info',
    description: 'Nothing has been written yet. The flag changes only once this is approved.',
    reviewable: true,
  },
  APPROVED: {
    label: 'approved',
    variant: 'ok',
    description:
      'Approved, but the write has not landed yet. Retrying the apply is safe — it is idempotent.',
    reviewable: false,
  },
  APPLIED: {
    label: 'applied',
    variant: 'ok',
    description: 'Approved and written. The flag is serving this change now.',
    reviewable: false,
  },
  DECLINED: {
    label: 'declined',
    variant: 'destructive',
    description: 'A reviewer refused this. The flag was left exactly as it was.',
    reviewable: false,
  },
  WITHDRAWN: {
    label: 'withdrawn',
    variant: 'secondary',
    description: 'The author took this back before it was reviewed. Nothing was written.',
    reviewable: false,
  },
  STALE: {
    label: 'stale',
    variant: 'warning',
    description:
      'The flag moved on before this could be applied, so Switchboard refused it rather than overwrite the newer version. It has to be recreated against the current config.',
    reviewable: false,
  },
}

export function changeRequestStatusMeta(status: ChangeRequestStatus): StatusMeta {
  return (
    CHANGE_REQUEST_STATUS_META[status] ?? {
      label: String(status).toLowerCase(),
      variant: 'outline' as StatusVariant,
      description: '',
      reviewable: false,
    }
  )
}

/**
 * "1 of 2" — approvals counted toward the threshold, over the threshold snapshotted when the
 * request was opened. Never shows more than the threshold: an applied request with three
 * approvals against a minimum of two still reads "2 of 2", because the extra one changed
 * nothing and "3 of 2" reads like a bug.
 */
export function formatApprovalProgress(cr: Pick<ChangeRequest, 'approvalsMet' | 'minApprovals'>): string {
  const required = Math.max(1, cr.minApprovals)
  const met = Math.min(Math.max(0, cr.approvalsMet), required)
  return `${met} of ${required}`
}

/** Long form for the detail page. Says how many are still needed rather than making you subtract. */
export function describeApprovalProgress(
  cr: Pick<ChangeRequest, 'approvalsMet' | 'minApprovals' | 'status'>,
): string {
  const required = Math.max(1, cr.minApprovals)
  const met = Math.min(Math.max(0, cr.approvalsMet), required)
  if (cr.status !== 'PENDING') return `${met} of ${required} approvals`
  const remaining = required - met
  if (remaining <= 0) return `${met} of ${required} approvals — the threshold is met`
  return `${met} of ${required} approvals — ${remaining} more ${remaining === 1 ? 'is' : 'are'} needed`
}

/** One-line gist for a list row or a toast. */
export function describeChangeRequestBriefly(cr: ChangeRequest): string {
  switch (cr.kind) {
    case 'KILL_SWITCH':
      return cr.payload.active
        ? `Kill ${cr.flagKey} in ${cr.envKey}`
        : `Clear the kill switch on ${cr.flagKey} in ${cr.envKey}`
    case 'ROLLBACK':
      return `Roll ${cr.flagKey} back to v${cr.payload.toVersion} in ${cr.envKey}`
    default:
      return `Change ${cr.flagKey} targeting in ${cr.envKey}`
  }
}

// ---------------------------------------------------------------- diff adapter

/**
 * A change request's payload rendered through the same machinery as an AI proposal's diff.
 *
 * The payload is the write in the shape the flag endpoints take, which is nearly an
 * `EnvChange` already — so rather than growing a second diff renderer, it is adapted into a
 * `FlagChangeDiff` and handed to the existing `summarizeDiff`/`DiffPreview`, which knows how
 * to say "Fallthrough 25% True / 75% False → 100% False" and where the before value is not
 * knowable.
 *
 * A ROLLBACK carries only a version number, which describes nothing on its own. Pass the
 * fetched snapshot of that version as `rollbackSnapshot` and it renders as the proposed
 * config, so a reviewer sees the targeting they would be restoring rather than "to v3".
 */
export function changeRequestToDiff(
  cr: ChangeRequest,
  rollbackSnapshot?: FlagVersion | null,
): FlagChangeDiff {
  if (cr.kind === 'ROLLBACK') {
    return {
      kind: 'ROLLBACK',
      flagKey: cr.flagKey,
      rollbackToVersion: cr.payload.toVersion,
      envChanges: rollbackSnapshot
        ? [
            {
              envKey: cr.envKey,
              enabled: rollbackSnapshot.enabled,
              killSwitchActive: rollbackSnapshot.killSwitchActive,
              config: rollbackSnapshot.config,
            },
          ]
        : [],
    }
  }

  if (cr.kind === 'KILL_SWITCH') {
    return {
      kind: 'FLAG_UPDATE',
      flagKey: cr.flagKey,
      envChanges: [{ envKey: cr.envKey, killSwitchActive: cr.payload.active }],
    }
  }

  return {
    kind: 'FLAG_UPDATE',
    flagKey: cr.flagKey,
    envChanges: [
      {
        envKey: cr.envKey,
        enabled: cr.payload.enabled,
        config: cr.payload.config,
      },
    ],
  }
}

// ---------------------------------------------------------------- who may do what

export interface ReviewerContext {
  /** The signed-in user's Switchboard id, or null while the profile is still loading. */
  userId: string | null
  /** Effective permissions at the request's scope. Null while they are still loading. */
  permissions: ReadonlySet<Permission> | null
}

export interface ActionAvailability {
  allowed: boolean
  /** Why not, in words a person can act on. Empty when allowed. */
  reason: string
}

const WAIT: ActionAvailability = { allowed: false, reason: 'Checking your permissions…' }

/**
 * Whether this viewer may approve, and if not, why.
 *
 * Self-approval is the case worth pre-empting in the UI: the backend refuses it with a 403,
 * and letting someone write a considered review comment and then hit that wall is a worse
 * experience than telling them up front that they cannot sign off on their own change.
 */
export function canApprove(cr: ChangeRequest, ctx: ReviewerContext): ActionAvailability {
  const meta = changeRequestStatusMeta(cr.status)
  if (!meta.reviewable) {
    return { allowed: false, reason: `This request is ${meta.label} — there is nothing to review.` }
  }
  if (ctx.permissions === null || ctx.userId === null) return WAIT
  if (!ctx.permissions.has('APPROVE_CHANGES')) {
    return {
      allowed: false,
      reason: `You cannot approve changes in ${cr.envKey}. Ask someone with the Approver or Admin role there to review it.`,
    }
  }
  if (!cr.allowSelfApproval && cr.requestedByUserId === ctx.userId) {
    return {
      allowed: false,
      reason: `This is your own request, and ${cr.envKey} does not allow self-approval. Someone else has to sign it off.`,
    }
  }
  if (cr.reviews.some((r) => r.reviewerUserId === ctx.userId && r.decision === 'APPROVE')) {
    return { allowed: false, reason: 'You have already approved this request.' }
  }
  return { allowed: true, reason: '' }
}

/** Declining needs APPROVE_CHANGES too, but never trips the self-approval rule. */
export function canDecline(cr: ChangeRequest, ctx: ReviewerContext): ActionAvailability {
  const meta = changeRequestStatusMeta(cr.status)
  if (!meta.reviewable) {
    return { allowed: false, reason: `This request is ${meta.label} — there is nothing to review.` }
  }
  if (ctx.permissions === null || ctx.userId === null) return WAIT
  if (!ctx.permissions.has('APPROVE_CHANGES')) {
    return {
      allowed: false,
      reason: `You cannot review changes in ${cr.envKey}. Ask someone with the Approver or Admin role there.`,
    }
  }
  return { allowed: true, reason: '' }
}

/** Author only, and only while it is still pending. No permission is involved. */
export function canWithdraw(cr: ChangeRequest, ctx: ReviewerContext): ActionAvailability {
  if (cr.status !== 'PENDING') {
    return {
      allowed: false,
      reason: `This request is ${changeRequestStatusMeta(cr.status).label} — it cannot be withdrawn.`,
    }
  }
  if (ctx.userId === null) return WAIT
  if (cr.requestedByUserId !== ctx.userId) {
    return { allowed: false, reason: 'Only the person who opened a request can withdraw it.' }
  }
  return { allowed: true, reason: '' }
}

/**
 * The manual retry, for an APPROVED request whose auto-apply write did not land. Hidden for
 * every other status: offering it on a PENDING request would look like a way around review.
 */
export function canApply(cr: ChangeRequest, ctx: ReviewerContext): ActionAvailability {
  if (cr.status !== 'APPROVED') {
    return { allowed: false, reason: 'Only an approved request that has not been written can be applied.' }
  }
  if (ctx.permissions === null) return WAIT
  if (!ctx.permissions.has('APPROVE_CHANGES')) {
    return { allowed: false, reason: `You cannot apply changes in ${cr.envKey}.` }
  }
  return { allowed: true, reason: '' }
}

/**
 * The toast for a write that came back 202. Says the same thing everywhere it happens,
 * because the one thing a person must not walk away with is the belief that they changed
 * the flag. "Saved" would be a lie; this names the environment's policy and what happens next.
 */
export function queuedWriteToast(cr: ChangeRequest): { title: string; description: string } {
  const verb =
    cr.kind === 'KILL_SWITCH'
      ? 'kill switch'
      : cr.kind === 'ROLLBACK'
        ? 'rollback'
        : 'targeting change'
  return {
    title: `Submitted for review — ${cr.flagKey} is unchanged`,
    description: `${cr.envKey} requires approval, so your ${verb} was opened as a change request instead of being written. It needs ${formatApprovalProgress(cr)} approvals.`,
  }
}
