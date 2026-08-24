import type { AuditAction, AuditEntry } from '@/types/api'

/**
 * How one audit action should read. Colour carries the family, not the individual action:
 * creating things is `ok`, taking something away is `warning`, an incident switch is
 * `destructive`, and routine bookkeeping stays neutral.
 *
 * `AI_APPLY` is the exception and gets its own treatment. A change made by the system with
 * no person in the loop is the one row in this feed you most need to spot while scrolling,
 * so it is tinted `info` and marked, never blended in with a human's UPDATE.
 */
export interface AuditActionMeta {
  label: string
  variant: 'ok' | 'warning' | 'destructive' | 'info' | 'secondary' | 'outline'
  /** True when no person performed this change. */
  automatic: boolean
}

const META: Record<AuditAction, AuditActionMeta> = {
  CREATE: { label: 'created', variant: 'ok', automatic: false },
  UPDATE: { label: 'updated', variant: 'secondary', automatic: false },
  KILL_SWITCH_ON: { label: 'killed', variant: 'destructive', automatic: false },
  KILL_SWITCH_OFF: { label: 'kill switch cleared', variant: 'ok', automatic: false },
  ROLLBACK: { label: 'rolled back', variant: 'warning', automatic: false },
  AI_APPLY: { label: 'applied by AI', variant: 'info', automatic: true },
  ARCHIVE: { label: 'archived', variant: 'warning', automatic: false },
  SEGMENT_CREATE: { label: 'segment created', variant: 'ok', automatic: false },
  SEGMENT_UPDATE: { label: 'segment updated', variant: 'secondary', automatic: false },
  SEGMENT_DELETE: { label: 'segment deleted', variant: 'warning', automatic: false },
  SDK_KEY_CREATE: { label: 'SDK key created', variant: 'ok', automatic: false },
  SDK_KEY_REVOKE: { label: 'SDK key revoked', variant: 'warning', automatic: false },
  MEMBER_ADD: { label: 'member added', variant: 'ok', automatic: false },
  MEMBER_REMOVE: { label: 'member removed', variant: 'warning', automatic: false },
  SETTINGS_UPDATE: { label: 'settings updated', variant: 'secondary', automatic: false },
  // Governance. Opening a request changed NOTHING, so it stays neutral; the apply is the row
  // that moved a flag and reads like the write it is.
  CHANGE_REQUEST_OPEN: { label: 'change requested', variant: 'info', automatic: false },
  CHANGE_REQUEST_APPLY: { label: 'change approved and applied', variant: 'ok', automatic: false },
  CHANGE_REQUEST_DECLINE: { label: 'change declined', variant: 'warning', automatic: false },
  ROLE_GRANT: { label: 'role granted', variant: 'ok', automatic: false },
  ROLE_REVOKE: { label: 'role revoked', variant: 'warning', automatic: false },
}

export function auditActionMeta(action: AuditAction): AuditActionMeta {
  // A backend that grows a new action must not blank out the feed, so unknowns fall back.
  return META[action] ?? { label: action.toLowerCase().replace(/_/g, ' '), variant: 'outline', automatic: false }
}

export interface AuditDay {
  /** Local calendar day, `YYYY-MM-DD`, used as the group key. */
  day: string
  /** "Today", "Yesterday", or an absolute date. */
  label: string
  items: AuditEntry[]
}

function localDay(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return 'unknown'
  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const dayOfMonth = `${date.getDate()}`.padStart(2, '0')
  return `${date.getFullYear()}-${month}-${dayOfMonth}`
}

/**
 * Groups a page of entries into local calendar days, preserving the newest-first order the
 * backend returned. Grouping is by LOCAL day on purpose: an operator reading "yesterday"
 * means their yesterday, not UTC's.
 */
export function groupByDay(entries: readonly AuditEntry[], now = new Date()): AuditDay[] {
  const today = localDay(now.toISOString())
  const yesterdayDate = new Date(now)
  yesterdayDate.setDate(yesterdayDate.getDate() - 1)
  const yesterday = localDay(yesterdayDate.toISOString())

  const groups: AuditDay[] = []
  for (const entry of entries) {
    const day = localDay(entry.createdAt)
    const last = groups[groups.length - 1]
    if (last && last.day === day) {
      last.items.push(entry)
      continue
    }
    const label =
      day === today
        ? 'Today'
        : day === yesterday
          ? 'Yesterday'
          : new Date(entry.createdAt).toLocaleDateString(undefined, {
              weekday: 'long',
              month: 'short',
              day: 'numeric',
              year: 'numeric',
            })
    groups.push({ day, label, items: [entry] })
  }
  return groups
}
