import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';
import { haptic } from '@shared/haptics';
import type { AnomalyFindingResponse } from '@shared/api/types';

import { monitorService } from '../services/monitorService';

export interface MonitorMutationScope {
  userId: string | undefined;
  /** Environment the findings belong to. */
  envId: string | undefined;
}

type AnomalySnapshot = [readonly unknown[], AnomalyFindingResponse[] | undefined][];

/** Prefix covering every status filter cached for one environment. */
function envAnomalyRoot(userId: string, envId: string): readonly unknown[] {
  return [...queryKeys.anomalies.all(userId), envId];
}

/**
 * Every anomaly list cached for this env — there is one per status filter, so a
 * single ack has to be reflected in all of them (and the ACKED row must appear
 * in the ACKED list, not just vanish from OPEN). Patching in place and letting
 * onSettled refetch keeps the banner honest either way.
 */
function patchAnomaly(
  client: QueryClient,
  userId: string,
  envId: string,
  anomalyId: string,
): AnomalySnapshot {
  const root = envAnomalyRoot(userId, envId);
  const snapshot = client.getQueriesData<AnomalyFindingResponse[]>({ queryKey: root });
  client.setQueriesData<AnomalyFindingResponse[]>({ queryKey: root }, (previous) =>
    Array.isArray(previous)
      ? previous.map((a) => (a.id === anomalyId ? { ...a, status: 'ACKED' as const } : a))
      : previous,
  );
  return snapshot;
}

export interface AckAnomalyVars {
  anomalyId: string;
}

/**
 * Acknowledge a finding. Optimistic: the banner count has to drop the instant
 * the button is tapped, or the operator taps it again. A failure (including the
 * 409 for an already-acked finding) restores the exact snapshot and rethrows.
 */
export function useAckAnomalyMutation(scope: MonitorMutationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ anomalyId }: AckAnomalyVars) => monitorService.ackAnomaly(anomalyId),

    onMutate: async ({ anomalyId }) => {
      if (!scope.userId || !scope.envId) return undefined;
      await client.cancelQueries({ queryKey: envAnomalyRoot(scope.userId, scope.envId) });
      return { snapshot: patchAnomaly(client, scope.userId, scope.envId, anomalyId) };
    },

    onError: (error, _vars, context) => {
      console.warn('[monitor] ack anomaly failed', error);
      context?.snapshot.forEach(([key, data]) => client.setQueryData(key, data));
    },

    onSuccess: () => haptic('success'),

    onSettled: () => {
      if (!scope.userId) return;
      void client.invalidateQueries({ queryKey: queryKeys.anomalies.all(scope.userId) });
    },
  });
}
