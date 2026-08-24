import { apiGet, apiPost, apiPut } from './apiClient'
import type {
  ApprovalSettings,
  ApprovalSettingsUpdateRequest,
  ChangeRequest,
  ChangeRequestDecisionRequest,
  ChangeRequestListResponse,
  ChangeRequestStatus,
} from '@/types/api'

export interface ListChangeRequestsParams {
  envKey?: string
  flagKey?: string
  status?: ChangeRequestStatus
  cursor?: string
  limit?: number
}

/**
 * Newest first, keyset cursor. The cursor encodes (createdAt, id), so requests opened while
 * you page do not shift the window.
 */
export function listChangeRequests(
  projectId: string,
  params: ListChangeRequestsParams = {},
): Promise<ChangeRequestListResponse> {
  const search = new URLSearchParams()
  if (params.envKey) search.set('envKey', params.envKey)
  if (params.flagKey) search.set('flagKey', params.flagKey)
  if (params.status) search.set('status', params.status)
  if (params.cursor) search.set('cursor', params.cursor)
  if (params.limit != null) search.set('limit', String(params.limit))
  const qs = search.toString()
  return apiGet<ChangeRequestListResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/change-requests${qs ? `?${qs}` : ''}`,
  )
}

export function getChangeRequest(changeRequestId: string): Promise<ChangeRequest> {
  return apiGet<ChangeRequest>(`/api/change-requests/${encodeURIComponent(changeRequestId)}`)
}

/**
 * Requires APPROVE_CHANGES in the request's environment. The approval that meets
 * `minApprovals` applies the change in the same call, so a 200 here can mean either "one
 * more approval recorded" or "the flag just moved" — read the returned status.
 *
 * 403 = no permission there, or self-approval where the environment forbids it. 409 = the
 * request already left PENDING.
 */
export function approveChangeRequest(
  changeRequestId: string,
  body: ChangeRequestDecisionRequest = {},
): Promise<ChangeRequest> {
  return apiPost<ChangeRequest>(
    `/api/change-requests/${encodeURIComponent(changeRequestId)}/approve`,
    body,
  )
}

/** One decline settles it. Requires APPROVE_CHANGES. */
export function declineChangeRequest(
  changeRequestId: string,
  body: ChangeRequestDecisionRequest = {},
): Promise<ChangeRequest> {
  return apiPost<ChangeRequest>(
    `/api/change-requests/${encodeURIComponent(changeRequestId)}/decline`,
    body,
  )
}

/** Author only; 403 for anyone else. */
export function withdrawChangeRequest(changeRequestId: string): Promise<ChangeRequest> {
  return apiPost<ChangeRequest>(
    `/api/change-requests/${encodeURIComponent(changeRequestId)}/withdraw`,
    {},
  )
}

/**
 * Idempotent retry for an APPROVED request whose auto-apply write did not land. Refuses
 * anything not already APPROVED (409), so it is not a way around review.
 */
export function applyChangeRequest(changeRequestId: string): Promise<ChangeRequest> {
  return apiPost<ChangeRequest>(
    `/api/change-requests/${encodeURIComponent(changeRequestId)}/apply`,
    {},
  )
}

// ---------------------------------------------------------------- approval policy

export function getApprovalSettings(envId: string): Promise<ApprovalSettings> {
  return apiGet<ApprovalSettings>(
    `/api/environments/${encodeURIComponent(envId)}/approval-settings`,
  )
}

/** Omitted fields are left unchanged. Requires MANAGE_ENVIRONMENTS. */
export function updateApprovalSettings(
  envId: string,
  body: ApprovalSettingsUpdateRequest,
): Promise<ApprovalSettings> {
  return apiPut<ApprovalSettings>(
    `/api/environments/${encodeURIComponent(envId)}/approval-settings`,
    body,
  )
}
