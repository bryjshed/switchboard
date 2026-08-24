import { describe, expect, it } from 'vitest'
import {
  appliedResult,
  classifyWriteResponse,
  isApplied,
  isQueued,
  queuedChangeRequestId,
  queuedResult,
} from '@/lib/writeResult'
import type { ChangeRequest, FlagEnvConfig } from '@/types/api'

const config: FlagEnvConfig = {
  flagId: 'flag-id',
  environmentId: 'env-id',
  envKey: 'production',
  enabled: true,
  killSwitchActive: false,
  config: {
    individualTargets: [],
    rules: [],
    fallthrough: { variationId: 'var-1' },
    offVariationId: 'var-1',
    defaultVariationId: 'var-1',
  },
  version: 9,
  updatedAt: '2026-08-21T00:00:00Z',
  updatedBy: 'alice@switchboard.dev',
}

const changeRequest: ChangeRequest = {
  id: 'cr-1',
  orgId: 'org-1',
  projectId: 'project-1',
  environmentId: 'env-id',
  envKey: 'production',
  flagId: 'flag-id',
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

describe('classifyWriteResponse', () => {
  it('reads a 200 as a write that actually landed', () => {
    const result = classifyWriteResponse<FlagEnvConfig>(200, config)
    expect(result.outcome).toBe('applied')
    if (result.outcome !== 'applied') throw new Error('expected applied')
    expect(result.config.version).toBe(9)
  })

  it('reads a 202 as a queued change request, NOT as a config', () => {
    const result = classifyWriteResponse<FlagEnvConfig>(202, changeRequest, '/api/change-requests/cr-1')
    expect(result.outcome).toBe('queued')
    if (result.outcome !== 'queued') throw new Error('expected queued')
    expect(result.changeRequest.id).toBe('cr-1')
    expect(result.changeRequest.status).toBe('PENDING')
    expect(result.location).toBe('/api/change-requests/cr-1')
  })

  it('tolerates a 202 with no Location header', () => {
    const result = classifyWriteResponse<FlagEnvConfig>(202, changeRequest)
    if (result.outcome !== 'queued') throw new Error('expected queued')
    expect(result.location).toBeNull()
  })

  // The whole point of the discriminated result: a caller that only handles one branch is a
  // type error, and a 202 can never be mistaken for "the flag now has a new version".
  it('never exposes a config on the queued branch', () => {
    const result = classifyWriteResponse<FlagEnvConfig>(202, changeRequest)
    expect('config' in result).toBe(false)
  })

  it('never exposes a change request on the applied branch', () => {
    const result = classifyWriteResponse<FlagEnvConfig>(200, config)
    expect('changeRequest' in result).toBe(false)
  })
})

describe('write result guards', () => {
  it('isQueued and isApplied are mutually exclusive', () => {
    const queued = queuedResult<FlagEnvConfig>(changeRequest)
    const applied = appliedResult(config)
    expect(isQueued(queued)).toBe(true)
    expect(isApplied(queued)).toBe(false)
    expect(isApplied(applied)).toBe(true)
    expect(isQueued(applied)).toBe(false)
  })

  it('names the change request id only for a queued write', () => {
    expect(queuedChangeRequestId(queuedResult<FlagEnvConfig>(changeRequest))).toBe('cr-1')
    expect(queuedChangeRequestId(appliedResult(config))).toBeNull()
  })
})
