import { describe, expect, it } from 'vitest'
import {
  CHANGE_REQUEST_STATUS_META,
  canApply,
  canApprove,
  canDecline,
  canWithdraw,
  changeRequestStatusMeta,
  changeRequestToDiff,
  describeApprovalProgress,
  describeChangeRequestBriefly,
  formatApprovalProgress,
  queuedWriteToast,
} from '@/lib/changeRequestDisplay'
import { CHANGE_REQUEST_STATUSES } from '@/types/api'
import type { ChangeRequest, FlagVersion, Permission } from '@/types/api'

const BASE: ChangeRequest = {
  id: 'cr-1',
  orgId: 'org-1',
  projectId: 'project-1',
  environmentId: 'env-prod',
  envKey: 'production',
  flagId: 'flag-1',
  flagKey: 'checkout-redesign',
  kind: 'TARGETING_UPDATE',
  payload: { enabled: true },
  baseVersion: 8,
  minApprovals: 2,
  allowSelfApproval: false,
  status: 'PENDING',
  requestedBy: 'alice@switchboard.dev',
  requestedByUserId: 'user-alice',
  createdAt: '2026-08-21T00:00:00Z',
  approvalsMet: 0,
  reviews: [],
}

const cr = (patch: Partial<ChangeRequest> = {}): ChangeRequest => ({ ...BASE, ...patch })
const perms = (...list: Permission[]) => new Set<Permission>(list)

describe('formatApprovalProgress', () => {
  it('reads as a fraction of the threshold', () => {
    expect(formatApprovalProgress({ approvalsMet: 1, minApprovals: 2 })).toBe('1 of 2')
  })

  it('caps at the threshold rather than reporting more approvals than needed', () => {
    expect(formatApprovalProgress({ approvalsMet: 3, minApprovals: 2 })).toBe('2 of 2')
  })

  it('treats a zero threshold as one — every request needs somebody', () => {
    expect(formatApprovalProgress({ approvalsMet: 0, minApprovals: 0 })).toBe('0 of 1')
  })

  it('never renders a negative count', () => {
    expect(formatApprovalProgress({ approvalsMet: -1, minApprovals: 2 })).toBe('0 of 2')
  })
})

describe('describeApprovalProgress', () => {
  it('says how many more are needed rather than making the reader subtract', () => {
    expect(describeApprovalProgress({ approvalsMet: 1, minApprovals: 3, status: 'PENDING' })).toBe(
      '1 of 3 approvals — 2 more are needed',
    )
  })

  it('uses the singular for the last one', () => {
    expect(describeApprovalProgress({ approvalsMet: 1, minApprovals: 2, status: 'PENDING' })).toBe(
      '1 of 2 approvals — 1 more is needed',
    )
  })

  it('stops asking for more once a request has been settled', () => {
    expect(describeApprovalProgress({ approvalsMet: 2, minApprovals: 2, status: 'APPLIED' })).toBe(
      '2 of 2 approvals',
    )
  })
})

describe('status display', () => {
  it('describes every status the spec defines', () => {
    for (const status of CHANGE_REQUEST_STATUSES) {
      const meta = changeRequestStatusMeta(status)
      expect(meta.label).toBeTruthy()
      expect(meta.description).toBeTruthy()
    }
    expect(Object.keys(CHANGE_REQUEST_STATUS_META)).toHaveLength(CHANGE_REQUEST_STATUSES.length)
  })

  it('marks only PENDING as reviewable', () => {
    const reviewable = CHANGE_REQUEST_STATUSES.filter((s) => changeRequestStatusMeta(s).reviewable)
    expect(reviewable).toEqual(['PENDING'])
  })

  // A stale or declined request that looks like a pending one wastes a reviewer's time, so
  // the three must not share a badge tint.
  it('gives STALE and DECLINED tints distinct from PENDING', () => {
    const pending = changeRequestStatusMeta('PENDING').variant
    expect(changeRequestStatusMeta('STALE').variant).not.toBe(pending)
    expect(changeRequestStatusMeta('DECLINED').variant).not.toBe(pending)
    expect(changeRequestStatusMeta('STALE').variant).not.toBe(
      changeRequestStatusMeta('DECLINED').variant,
    )
  })

  it('explains a stale request as needing recreation, not retrying', () => {
    expect(changeRequestStatusMeta('STALE').description).toMatch(/recreated/i)
  })

  it('falls back rather than blanking out for a status this build has not seen', () => {
    const meta = changeRequestStatusMeta('SOMETHING_NEW' as never)
    expect(meta.label).toBe('something_new')
    expect(meta.reviewable).toBe(false)
  })
})

describe('describeChangeRequestBriefly', () => {
  it('says which direction a kill switch request goes', () => {
    expect(describeChangeRequestBriefly(cr({ kind: 'KILL_SWITCH', payload: { active: true } }))).toBe(
      'Kill checkout-redesign in production',
    )
    expect(
      describeChangeRequestBriefly(cr({ kind: 'KILL_SWITCH', payload: { active: false } })),
    ).toBe('Clear the kill switch on checkout-redesign in production')
  })

  it('names the target version of a rollback', () => {
    expect(describeChangeRequestBriefly(cr({ kind: 'ROLLBACK', payload: { toVersion: 4 } }))).toBe(
      'Roll checkout-redesign back to v4 in production',
    )
  })
})

describe('queuedWriteToast', () => {
  it('leads with the fact that the flag did NOT change', () => {
    const toast = queuedWriteToast(cr())
    expect(toast.title).toMatch(/unchanged/i)
    expect(toast.title).toContain('checkout-redesign')
    expect(toast.description).toContain('production')
    expect(toast.description).toContain('0 of 2')
  })

  it('names the kind of write that was parked', () => {
    expect(queuedWriteToast(cr({ kind: 'KILL_SWITCH' })).description).toContain('kill switch')
    expect(queuedWriteToast(cr({ kind: 'ROLLBACK' })).description).toContain('rollback')
  })
})

describe('changeRequestToDiff', () => {
  it('turns a targeting payload into a single-environment diff', () => {
    const diff = changeRequestToDiff(
      cr({
        payload: {
          enabled: false,
          config: {
            individualTargets: [],
            rules: [],
            fallthrough: { variationId: 'var-off' },
            offVariationId: 'var-off',
            defaultVariationId: 'var-off',
          },
        },
      }),
    )
    expect(diff.flagKey).toBe('checkout-redesign')
    expect(diff.envChanges).toHaveLength(1)
    expect(diff.envChanges?.[0].envKey).toBe('production')
    expect(diff.envChanges?.[0].enabled).toBe(false)
    expect(diff.envChanges?.[0].config?.offVariationId).toBe('var-off')
  })

  it('maps a kill switch payload onto killSwitchActive, not enabled', () => {
    const diff = changeRequestToDiff(cr({ kind: 'KILL_SWITCH', payload: { active: true } }))
    expect(diff.envChanges?.[0].killSwitchActive).toBe(true)
    expect(diff.envChanges?.[0].enabled).toBeUndefined()
  })

  it('carries the target version of a rollback even with no snapshot to show', () => {
    const diff = changeRequestToDiff(cr({ kind: 'ROLLBACK', payload: { toVersion: 3 } }))
    expect(diff.kind).toBe('ROLLBACK')
    expect(diff.rollbackToVersion).toBe(3)
    expect(diff.envChanges).toEqual([])
  })

  it('renders the fetched snapshot as the proposed config for a rollback', () => {
    const snapshot: FlagVersion = {
      versionNumber: 3,
      enabled: true,
      killSwitchActive: false,
      config: {
        individualTargets: [],
        rules: [],
        fallthrough: { variationId: 'var-a' },
        offVariationId: 'var-a',
        defaultVariationId: 'var-a',
      },
      createdBy: 'alice@switchboard.dev',
      createdAt: '2026-08-01T00:00:00Z',
    }
    const diff = changeRequestToDiff(cr({ kind: 'ROLLBACK', payload: { toVersion: 3 } }), snapshot)
    expect(diff.envChanges?.[0].config?.fallthrough.variationId).toBe('var-a')
  })
})

describe('who may act on a request', () => {
  const bob = { userId: 'user-bob', permissions: perms('APPROVE_CHANGES', 'FLAG_READ') }
  const alice = { userId: 'user-alice', permissions: perms('APPROVE_CHANGES', 'FLAG_READ') }
  const reader = { userId: 'user-bob', permissions: perms('FLAG_READ') }

  it('lets a reviewer with APPROVE_CHANGES approve someone else’s pending request', () => {
    expect(canApprove(cr(), bob).allowed).toBe(true)
  })

  it('refuses self-approval up front, with the reason, rather than letting it 403', () => {
    const result = canApprove(cr(), alice)
    expect(result.allowed).toBe(false)
    expect(result.reason).toMatch(/your own request/i)
    expect(result.reason).toMatch(/self-approval/i)
  })

  it('allows self-approval where the environment permits it', () => {
    expect(canApprove(cr({ allowSelfApproval: true }), alice).allowed).toBe(true)
  })

  it('refuses a viewer without APPROVE_CHANGES and names the environment', () => {
    const result = canApprove(cr(), reader)
    expect(result.allowed).toBe(false)
    expect(result.reason).toContain('production')
  })

  it('refuses a second approval from the same reviewer', () => {
    const withBobsApproval = cr({
      approvalsMet: 1,
      reviews: [
        {
          id: 'review-1',
          reviewerUserId: 'user-bob',
          reviewer: 'bob@switchboard.dev',
          decision: 'APPROVE',
          createdAt: '2026-08-21T01:00:00Z',
        },
      ],
    })
    expect(canApprove(withBobsApproval, bob).reason).toMatch(/already approved/i)
  })

  it('offers nothing on a request that is no longer pending', () => {
    for (const status of ['APPLIED', 'DECLINED', 'WITHDRAWN', 'STALE'] as const) {
      expect(canApprove(cr({ status }), bob).allowed).toBe(false)
      expect(canDecline(cr({ status }), bob).allowed).toBe(false)
    }
  })

  it('lets the author decline their own request — only APPROVING is self-restricted', () => {
    expect(canDecline(cr(), alice).allowed).toBe(true)
  })

  it('lets only the author withdraw, and only while pending', () => {
    expect(canWithdraw(cr(), alice).allowed).toBe(true)
    expect(canWithdraw(cr(), bob).allowed).toBe(false)
    expect(canWithdraw(cr({ status: 'APPLIED' }), alice).allowed).toBe(false)
  })

  it('offers the manual apply only for an APPROVED request', () => {
    expect(canApply(cr({ status: 'APPROVED' }), bob).allowed).toBe(true)
    expect(canApply(cr({ status: 'PENDING' }), bob).allowed).toBe(false)
  })

  it('waits rather than guessing while permissions are still loading', () => {
    const loading = { userId: 'user-bob', permissions: null }
    expect(canApprove(cr(), loading).allowed).toBe(false)
    expect(canApprove(cr(), loading).reason).toMatch(/checking/i)
  })
})
