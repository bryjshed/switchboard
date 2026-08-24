import { api } from '@shared/api/client';
import type {
  AiProposalListResponse,
  AiProposalResponse,
  ProposalActionRequest,
  ProposalDraftRequest,
  ProposalStatus,
} from '@shared/api/types';

export interface ListProposalsParams {
  status?: ProposalStatus;
  cursor?: string;
  limit?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/**
 * AI proposal reads and writes.
 *
 * `draft` is the only endpoint that can answer 503 AI_UNAVAILABLE (no provider
 * key on the server). That is a normal, expected state — screens render it as
 * an explanatory panel — so it is NOT special-cased here: it arrives as a plain
 * ApiClientError with code AI_UNAVAILABLE and callers decide.
 */
export const aiService = {
  draft: (projectId: string, body: ProposalDraftRequest) =>
    api.post<AiProposalResponse>(`/api/projects/${projectId}/ai/proposals`, body),

  list: (projectId: string, params: ListProposalsParams = {}) =>
    api.get<AiProposalListResponse>(
      `/api/projects/${projectId}/ai/proposals${qs({ ...params })}`,
    ),

  get: (proposalId: string) => api.get<AiProposalResponse>(`/api/ai/proposals/${proposalId}`),

  /** 409 CONFLICT when the proposal is no longer DRAFT (already applied/rejected). */
  apply: (proposalId: string, body: ProposalActionRequest = {}) =>
    api.post<AiProposalResponse>(`/api/ai/proposals/${proposalId}/apply`, body),

  reject: (proposalId: string, body: ProposalActionRequest = {}) =>
    api.post<AiProposalResponse>(`/api/ai/proposals/${proposalId}/reject`, body),
};
