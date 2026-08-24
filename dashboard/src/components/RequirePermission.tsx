import { Lock } from 'lucide-react'
import { cn } from '@/lib/utils'
import { usePermissionGate } from '@/hooks/usePermissions'
import type { Permission } from '@/types/api'

export interface RequirePermissionProps {
  /** The capability the wrapped controls need at the active scope. */
  permission: Permission
  children: React.ReactNode
  /**
   * What to show instead when the viewer lacks it. Defaults to a one-line caption naming the
   * missing capability — silence is worse than a refusal, because a control that simply is
   * not there reads as a bug.
   */
  fallback?: React.ReactNode
  /** Render nothing at all when denied. For controls whose absence is self-explanatory. */
  silent?: boolean
  className?: string
}

/**
 * Hides or explains a control the signed-in user may not use.
 *
 * This is courtesy, not security. Every one of these actions is checked again by the
 * backend, and must be: anything that relied on this component to keep someone out would be
 * one devtools inspection away from being wide open. Its whole job is that people are not
 * offered buttons that will come back 403.
 *
 * While permissions are still loading it renders the fallback rather than the children, so a
 * control never flashes into view and then disappears.
 */
export function RequirePermission({
  permission,
  children,
  fallback,
  silent,
  className,
}: RequirePermissionProps) {
  const { allowed, loading, reason } = usePermissionGate(permission)

  if (allowed) return <>{children}</>
  if (silent) return null
  if (fallback !== undefined) return <>{fallback}</>

  return (
    <p
      className={cn('flex items-start gap-1.5 text-xs text-muted-foreground', className)}
      data-testid={`permission-denied-${permission}`}
    >
      <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
      <span>{loading ? 'Checking your permissions…' : reason}</span>
    </p>
  )
}
