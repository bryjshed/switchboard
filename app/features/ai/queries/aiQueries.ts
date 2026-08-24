import { queryOptions } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';
import type { ProposalStatus } from '@shared/api/types';

import { aiService } from '../services/aiService';

/** Recent proposals for a project, newest first. Status narrows server-side. */
export function proposalsListOptions(
  userId: string | undefined,
  projectId: string | undefined,
  status?: ProposalStatus,
  limit = 25,
) {
  return queryOptions({
    queryKey: queryKeys.proposals.list(userId ?? 'anonymous', projectId ?? 'none', status),
    queryFn: () => aiService.list(projectId as string, { status, limit }),
    enabled: !!userId && !!projectId,
    staleTime: 15_000,
  });
}

/** One proposal by id. Keyed off the user alone — the endpoint is project-free. */
export function proposalDetailOptions(userId: string | undefined, proposalId: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.proposals.detail(userId ?? 'anonymous', proposalId ?? 'none'),
    queryFn: () => aiService.get(proposalId as string),
    enabled: !!userId && !!proposalId,
    staleTime: 10_000,
  });
}
