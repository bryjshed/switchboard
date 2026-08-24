import { apiGet, apiPost } from './apiClient'
import type {
  AiProposal,
  AiProposalListResponse,
  ProposalActionRequest,
  ProposalDraftRequest,
  ProposalStatus,
} from '@/types/api'

/**
 * Natural language in, reviewable DRAFT proposal out. Nothing is written to a flag here —
 * the draft only becomes a change when someone applies it.
 *
 * Rejects with `ApiClientError { status: 503, code: 'AI_UNAVAILABLE' }` when the server has
 * no model provider configured. That is a normal deployment state, not a bug: monitoring,
 * healing and optimizing all run without a key. Callers must render it as an explanation
 * rather than an error — see `AskAiDialog`.
 */
export function draftProposal(
  projectId: string,
  body: ProposalDraftRequest,
): Promise<AiProposal> {
  return apiPost<AiProposal>(
    `/api/projects/${encodeURIComponent(projectId)}/ai/proposals`,
    body,
  )
}

export interface ListProposalsParams {
  status?: ProposalStatus
  cursor?: string
  limit?: number
}

export function listProposals(
  projectId: string,
  params: ListProposalsParams = {},
): Promise<AiProposalListResponse> {
  const search = new URLSearchParams()
  if (params.status) search.set('status', params.status)
  if (params.cursor) search.set('cursor', params.cursor)
  if (params.limit != null) search.set('limit', String(params.limit))
  const qs = search.toString()
  return apiGet<AiProposalListResponse>(
    `/api/projects/${encodeURIComponent(projectId)}/ai/proposals${qs ? `?${qs}` : ''}`,
  )
}

export function getProposal(proposalId: string): Promise<AiProposal> {
  return apiGet<AiProposal>(`/api/ai/proposals/${encodeURIComponent(proposalId)}`)
}

/**
 * Writes the diff. 409 (surfaced as `ConflictError`) means the proposal already left DRAFT —
 * someone else applied or rejected it — so the caller refreshes rather than retrying.
 */
export function applyProposal(
  proposalId: string,
  body: ProposalActionRequest = {},
): Promise<AiProposal> {
  return apiPost<AiProposal>(`/api/ai/proposals/${encodeURIComponent(proposalId)}/apply`, body)
}

export function rejectProposal(
  proposalId: string,
  body: ProposalActionRequest = {},
): Promise<AiProposal> {
  return apiPost<AiProposal>(`/api/ai/proposals/${encodeURIComponent(proposalId)}/reject`, body)
}
