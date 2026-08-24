import { queryOptions } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';
import type { AnomalyStatus } from '@shared/api/types';

import { monitorService } from '../services/monitorService';

/**
 * Findings for one environment. Anomalies are the "something is on fire" feed,
 * so they go stale fast — a 10s staleTime keeps a tab revisit honest without
 * hammering the endpoint on every render.
 */
export function anomaliesOptions(
  userId: string | undefined,
  envId: string | undefined,
  status?: AnomalyStatus,
) {
  return queryOptions({
    queryKey: queryKeys.anomalies.list(userId ?? 'anonymous', envId ?? 'none', status),
    queryFn: () => monitorService.listAnomalies(envId as string, status),
    enabled: !!userId && !!envId,
    staleTime: 10_000,
  });
}

export function rolloutStatsOptions(
  userId: string | undefined,
  envId: string | undefined,
  flagKey: string | undefined,
  hours: number,
) {
  return queryOptions({
    queryKey: queryKeys.rolloutStats.detail(
      userId ?? 'anonymous',
      envId ?? 'none',
      flagKey ?? 'none',
      hours,
    ),
    queryFn: () => monitorService.rolloutStats(envId as string, flagKey as string, hours),
    enabled: !!userId && !!envId && !!flagKey,
    staleTime: 30_000,
  });
}
