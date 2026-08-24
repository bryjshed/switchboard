import type { FlagEnvSummary } from '@/types/api'

/**
 * The one-word (or one-percentage) state of a flag in one environment. Kill switch wins over
 * enabled, matching the backend's evaluation precedence.
 */
export function flagEnvStateLabel(
  summary: Pick<FlagEnvSummary, 'enabled' | 'killSwitchActive' | 'rolloutPercentage'>,
): string {
  if (summary.killSwitchActive) return 'killed'
  if (!summary.enabled) return 'off'
  return summary.rolloutPercentage != null ? `${summary.rolloutPercentage}%` : 'on'
}
