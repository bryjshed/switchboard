import { cn } from '@/lib/utils'
import { envChipClasses, envDotClasses } from '@/lib/envColors'

/** A small dot in the environment's identity colour. */
export function EnvDot({ envKey, className }: { envKey: string; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('inline-block h-2 w-2 shrink-0 rounded-full', envDotClasses(envKey), className)}
    />
  )
}

/** Bordered chip naming an environment in its identity colour. */
export function EnvChip({
  envKey,
  className,
  children,
}: {
  envKey: string
  className?: string
  children?: React.ReactNode
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium',
        envChipClasses(envKey),
        className,
      )}
    >
      <EnvDot envKey={envKey} />
      {children ?? envKey}
    </span>
  )
}
