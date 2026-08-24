import { apiGet, apiPost } from './apiClient'
import type { AnomalyFinding, AnomalyStatus, RolloutStats } from '@/types/api'

/** Omitting `status` returns findings in every state, newest first. */
export function listAnomalies(envId: string, status?: AnomalyStatus): Promise<AnomalyFinding[]> {
  const qs = status ? `?status=${encodeURIComponent(status)}` : ''
  return apiGet<AnomalyFinding[]>(`/api/environments/${encodeURIComponent(envId)}/anomalies${qs}`)
}

/**
 * Marks a finding as seen. 409 (`ConflictError`) means it is no longer OPEN — someone else
 * acknowledged it, or the auto-rollback already acted on it.
 */
export function ackAnomaly(anomalyId: string): Promise<AnomalyFinding> {
  return apiPost<AnomalyFinding>(`/api/anomalies/${encodeURIComponent(anomalyId)}/ack`, {})
}

/**
 * Per-variant eval counts and metric rates over the last `hours`, both as totals and bucketed
 * hourly. Rates are 0..1 fractions, never percentages — see `formatRate`.
 */
export function getRolloutStats(
  envId: string,
  flagKey: string,
  hours: number,
): Promise<RolloutStats> {
  return apiGet<RolloutStats>(
    `/api/environments/${encodeURIComponent(envId)}/flags/${encodeURIComponent(flagKey)}` +
      `/rollout-stats?hours=${hours}`,
  )
}
