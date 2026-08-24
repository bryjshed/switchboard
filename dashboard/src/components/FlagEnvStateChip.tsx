import { Ban } from 'lucide-react'
import { cn } from '@/lib/utils'
import { envChipClasses } from '@/lib/envColors'
import { EnvDot } from './EnvChip'
import { flagEnvStateLabel } from '@/lib/flagEnvState'
import type { FlagEnvSummary } from '@/types/api'

export interface FlagEnvStateChipProps {
  summary: Pick<FlagEnvSummary, 'envKey' | 'enabled' | 'killSwitchActive' | 'rolloutPercentage'>
  className?: string
}

/**
 * One environment's state on a flag. The environment's identity colour carries the *which*;
 * the kill switch overrides it with destructive styling because "this is switched off in an
 * incident" must read differently from "this environment is production".
 */
export function FlagEnvStateChip({ summary, className }: FlagEnvStateChipProps) {
  const killed = summary.killSwitchActive
  const off = !summary.enabled && !killed
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        killed
          ? 'border-destructive/50 bg-destructive/10 text-destructive'
          : envChipClasses(summary.envKey),
        off && 'opacity-60',
        className,
      )}
      title={`${summary.envKey}: ${flagEnvStateLabel(summary)}`}
      data-testid={`env-state-${summary.envKey}`}
    >
      {killed ? <Ban className="h-3 w-3 shrink-0" aria-hidden /> : <EnvDot envKey={summary.envKey} />}
      <span className="font-mono">{summary.envKey}</span>
      <span className="opacity-70">·</span>
      <span>{flagEnvStateLabel(summary)}</span>
    </span>
  )
}
