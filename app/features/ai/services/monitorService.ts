import { api } from '@shared/api/client';
import type {
  AnomalyFindingResponse,
  AnomalyStatus,
  RolloutStatsResponse,
} from '@shared/api/types';

/**
 * Monitoring reads. Both endpoints hang off an ENVIRONMENT ID (not an env key),
 * so callers resolve the id from the active project's embedded environments.
 */
export const monitorService = {
  listAnomalies: (envId: string, status?: AnomalyStatus) =>
    api.get<AnomalyFindingResponse[]>(
      `/api/environments/${envId}/anomalies${status ? `?status=${status}` : ''}`,
    ),

  /** 409 CONFLICT when the finding was already acknowledged. */
  ackAnomaly: (anomalyId: string) =>
    api.post<AnomalyFindingResponse>(`/api/anomalies/${anomalyId}/ack`),

  rolloutStats: (envId: string, flagKey: string, hours: number) =>
    api.get<RolloutStatsResponse>(
      `/api/environments/${envId}/flags/${encodeURIComponent(flagKey)}/rollout-stats?hours=${hours}`,
    ),
};
