import { apiGet } from './apiClient'
import type { AuditListResponse } from '@/types/api'

export interface AuditParams {
  cursor?: string
  limit?: number
}

export interface ProjectAuditParams extends AuditParams {
  env?: string
  flagKey?: string
}

function query(params: Record<string, string | number | undefined>): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') search.set(key, String(value))
  }
  const qs = search.toString()
  return qs ? `?${qs}` : ''
}

/**
 * Keyset paging: pass the previous response's `nextCursor` to append the next page. The
 * cursor encodes (createdAt, id), so entries written while you page do not shift the window.
 */
export function listProjectAudit(
  projectId: string,
  params: ProjectAuditParams = {},
): Promise<AuditListResponse> {
  return apiGet<AuditListResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/audit${query({ ...params })}`,
  )
}

/** Everything across the org, including entries no project filter would show (members, settings). */
export function listOrgAudit(orgId: string, params: AuditParams = {}): Promise<AuditListResponse> {
  return apiGet<AuditListResponse>(
    `/api/orgs/${encodeURIComponent(orgId)}/audit${query({ ...params })}`,
  )
}
