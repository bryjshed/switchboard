import { apiDelete, apiGet, apiPatch, apiPost, apiSendGated } from './apiClient'
import type { WriteResult } from './writeResult'
import type {
  FlagCreateRequest,
  FlagDetail,
  FlagEnvConfig,
  FlagEnvConfigUpdateRequest,
  FlagListResponse,
  FlagUpdateRequest,
  FlagVersion,
  FlagVersionListResponse,
  KillSwitchRequest,
  RollbackRequest,
} from '@/types/api'

function flagBase(projectId: string, flagKey: string): string {
  return `/api/projects/${encodeURIComponent(projectId)}/flags/${encodeURIComponent(flagKey)}`
}

function envBase(projectId: string, flagKey: string, envKey: string): string {
  return `${flagBase(projectId, flagKey)}/environments/${encodeURIComponent(envKey)}`
}

export interface ListFlagsParams {
  query?: string
  tag?: string
  cursor?: string
  limit?: number
}

export function listFlags(projectId: string, params: ListFlagsParams = {}): Promise<FlagListResponse> {
  const search = new URLSearchParams()
  if (params.query) search.set('query', params.query)
  if (params.tag) search.set('tag', params.tag)
  if (params.cursor) search.set('cursor', params.cursor)
  if (params.limit != null) search.set('limit', String(params.limit))
  const qs = search.toString()
  return apiGet<FlagListResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/flags${qs ? `?${qs}` : ''}`,
  )
}

export function getFlag(projectId: string, flagKey: string): Promise<FlagDetail> {
  return apiGet<FlagDetail>(flagBase(projectId, flagKey))
}

export function createFlag(projectId: string, body: FlagCreateRequest): Promise<FlagDetail> {
  return apiPost<FlagDetail>(`/api/projects/${encodeURIComponent(projectId)}/flags`, body)
}

export function updateFlag(
  projectId: string,
  flagKey: string,
  body: FlagUpdateRequest,
): Promise<FlagDetail> {
  return apiPatch<FlagDetail>(flagBase(projectId, flagKey), body)
}

/** Soft delete. The flag disappears from listings but its history is retained. */
export function archiveFlag(projectId: string, flagKey: string): Promise<void> {
  return apiDelete(flagBase(projectId, flagKey))
}

/**
 * The full targeting write. Sending `expectedVersion` opts into optimistic concurrency:
 * a stale value rejects with 409 (surfaced as `ConflictError`) rather than clobbering
 * someone else's edit. Omitting it force-writes — the UI always sends it.
 *
 * Resolves to a `WriteResult`, not a config: in an environment with `requireApproval` on
 * the backend answers 202 and writes NOTHING, handing back the change request that now
 * stands in for this edit. Callers must branch on `outcome` — see `WriteResult`.
 */
export function updateFlagEnvConfig(
  projectId: string,
  flagKey: string,
  envKey: string,
  body: FlagEnvConfigUpdateRequest,
): Promise<WriteResult<FlagEnvConfig>> {
  return apiSendGated<FlagEnvConfig>('PUT', envBase(projectId, flagKey, envKey), body)
}

/**
 * Deliberately version-free: an incident response must never lose a race.
 *
 * Bypasses approval by default even where targeting writes are gated — an emergency stop
 * queued behind a reviewer is an outage. It only answers 202 when someone has deliberately
 * turned on `requireApprovalForKill` for the environment.
 */
export function setKillSwitch(
  projectId: string,
  flagKey: string,
  envKey: string,
  body: KillSwitchRequest,
): Promise<WriteResult<FlagEnvConfig>> {
  return apiSendGated<FlagEnvConfig>(
    'POST',
    `${envBase(projectId, flagKey, envKey)}/kill-switch`,
    body,
  )
}

export function listFlagVersions(
  projectId: string,
  flagKey: string,
  envKey: string,
  params: { cursor?: string; limit?: number } = {},
): Promise<FlagVersionListResponse> {
  const search = new URLSearchParams()
  if (params.cursor) search.set('cursor', params.cursor)
  if (params.limit != null) search.set('limit', String(params.limit))
  const qs = search.toString()
  return apiGet<FlagVersionListResponse>(
    `${envBase(projectId, flagKey, envKey)}/versions${qs ? `?${qs}` : ''}`,
  )
}

export function getFlagVersion(
  projectId: string,
  flagKey: string,
  envKey: string,
  versionNumber: number,
): Promise<FlagVersion> {
  return apiGet<FlagVersion>(`${envBase(projectId, flagKey, envKey)}/versions/${versionNumber}`)
}

/**
 * Writes a NEW version that copies the target snapshot; history is never rewritten.
 * Gated like the targeting write — may resolve to a queued change request instead.
 */
export function rollbackFlagEnvConfig(
  projectId: string,
  flagKey: string,
  envKey: string,
  body: RollbackRequest,
): Promise<WriteResult<FlagEnvConfig>> {
  return apiSendGated<FlagEnvConfig>(
    'POST',
    `${envBase(projectId, flagKey, envKey)}/rollback`,
    body,
  )
}
