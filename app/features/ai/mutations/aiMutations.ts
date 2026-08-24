import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';
import { haptic } from '@shared/haptics';
import type {
  AiProposalListResponse,
  AiProposalResponse,
  ProposalDraftRequest,
  ProposalStatus,
} from '@shared/api/types';

import { aiService } from '../services/aiService';

export interface AiMutationScope {
  userId: string | undefined;
  orgId: string | undefined;
  projectId: string | undefined;
}

/**
 * Applying a proposal rewrites flag config server-side, so everything the flag
 * screens read has to go: the flags list, that flag's detail and versions, both
 * audit feeds, the proposal itself, and any anomaly whose suggestion this was.
 */
function invalidateAfterApply(
  client: QueryClient,
  { userId, orgId, projectId }: AiMutationScope,
  proposal: AiProposalResponse,
): void {
  if (!userId) return;
  if (projectId) {
    void client.invalidateQueries({ queryKey: queryKeys.flags.all(userId, projectId) });
    void client.invalidateQueries({ queryKey: queryKeys.proposals.all(userId, projectId) });
    void client.invalidateQueries({ queryKey: queryKeys.audit.project(userId, projectId) });
  }
  if (orgId) void client.invalidateQueries({ queryKey: queryKeys.audit.list(userId, orgId) });
  void client.invalidateQueries({ queryKey: queryKeys.anomalies.all(userId) });
  void client.invalidateQueries({
    queryKey: queryKeys.proposals.detail(userId, proposal.id),
  });
}

type ListSnapshot = [readonly unknown[], AiProposalListResponse | undefined][];

/** Flips one proposal's status in every cached list page and in its detail. */
function patchProposalStatus(
  client: QueryClient,
  scope: AiMutationScope,
  proposalId: string,
  status: ProposalStatus,
): { lists: ListSnapshot; detailKey: readonly unknown[] | null; detail: AiProposalResponse | undefined } {
  const { userId, projectId } = scope;
  if (!userId) return { lists: [], detailKey: null, detail: undefined };
  const lists: ListSnapshot = projectId
    ? client.getQueriesData<AiProposalListResponse>({
        queryKey: queryKeys.proposals.all(userId, projectId),
      })
    : [];
  if (projectId) {
    client.setQueriesData<AiProposalListResponse>(
      { queryKey: queryKeys.proposals.all(userId, projectId) },
      (previous) =>
        previous && Array.isArray(previous.items)
          ? {
              ...previous,
              items: previous.items.map((p) => (p.id === proposalId ? { ...p, status } : p)),
            }
          : previous,
    );
  }
  const detailKey = queryKeys.proposals.detail(userId, proposalId);
  const detail = client.getQueryData<AiProposalResponse>(detailKey);
  client.setQueryData<AiProposalResponse>(detailKey, (previous) =>
    previous ? { ...previous, status } : previous,
  );
  return { lists, detailKey, detail };
}

function restore(
  client: QueryClient,
  lists: ListSnapshot,
  detailKey: readonly unknown[] | null,
  detail: AiProposalResponse | undefined,
): void {
  lists.forEach(([key, data]) => client.setQueryData(key, data));
  if (detailKey) client.setQueryData(detailKey, detail);
}

export interface ProposalActionVars {
  proposalId: string;
  reason?: string;
}

/**
 * Apply. Optimistic only on the status pill — the resulting flag config comes
 * from the server, so nothing about the flag itself is predicted locally.
 * A 409 (already applied elsewhere) rolls the pill back and rethrows so the
 * screen can say so and refetch.
 */
export function useApplyProposalMutation(scope: AiMutationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ proposalId, reason }: ProposalActionVars) =>
      aiService.apply(proposalId, { reason }),

    onMutate: async ({ proposalId }) => {
      if (!scope.userId) return undefined;
      await client.cancelQueries({ queryKey: queryKeys.proposals.detail(scope.userId, proposalId) });
      return patchProposalStatus(client, scope, proposalId, 'APPLIED');
    },

    onError: (error, _vars, context) => {
      console.warn('[ai] apply proposal failed', error);
      if (context) restore(client, context.lists, context.detailKey, context.detail);
    },

    onSuccess: (proposal: AiProposalResponse) => {
      haptic('success');
      if (scope.userId) {
        client.setQueryData(queryKeys.proposals.detail(scope.userId, proposal.id), proposal);
      }
      invalidateAfterApply(client, scope, proposal);
    },
  });
}

export function useRejectProposalMutation(scope: AiMutationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ proposalId, reason }: ProposalActionVars) =>
      aiService.reject(proposalId, { reason }),

    onMutate: async ({ proposalId }) => {
      if (!scope.userId) return undefined;
      await client.cancelQueries({ queryKey: queryKeys.proposals.detail(scope.userId, proposalId) });
      return patchProposalStatus(client, scope, proposalId, 'REJECTED');
    },

    onError: (error, _vars, context) => {
      console.warn('[ai] reject proposal failed', error);
      if (context) restore(client, context.lists, context.detailKey, context.detail);
    },

    onSuccess: (proposal: AiProposalResponse) => {
      haptic('warning');
      if (scope.userId) {
        client.setQueryData(queryKeys.proposals.detail(scope.userId, proposal.id), proposal);
        if (scope.projectId) {
          void client.invalidateQueries({
            queryKey: queryKeys.proposals.all(scope.userId, scope.projectId),
          });
        }
      }
    },
  });
}

/**
 * Draft a proposal from natural language. No optimistic anything — this is the
 * one call that can answer 503 AI_UNAVAILABLE, and the sheet renders that as an
 * explanation rather than an error.
 */
export function useDraftProposalMutation(scope: AiMutationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: ProposalDraftRequest) => aiService.draft(scope.projectId as string, body),
    onError: (error) => {
      console.warn('[ai] draft proposal failed', error);
    },
    onSuccess: (proposal: AiProposalResponse) => {
      haptic('success');
      if (scope.userId) {
        client.setQueryData(queryKeys.proposals.detail(scope.userId, proposal.id), proposal);
        if (scope.projectId) {
          void client.invalidateQueries({
            queryKey: queryKeys.proposals.all(scope.userId, scope.projectId),
          });
        }
      }
    },
  });
}
