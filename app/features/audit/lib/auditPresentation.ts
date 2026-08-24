import { dayKey, dayLabel } from '@shared/lib/time';
import type { AuditAction, AuditEntryResponse } from '@shared/api/types';
import type { BadgeTone } from '@shared/ui';

/** Tone families: created things read success, destructive reads error,
 * anything reversible-but-loud reads warning, edits stay neutral. */
export function actionTone(action: AuditAction): BadgeTone {
  switch (action) {
    case 'CREATE':
    case 'SEGMENT_CREATE':
    case 'SDK_KEY_CREATE':
    case 'MEMBER_ADD':
      return 'success';
    case 'KILL_SWITCH_ON':
    case 'ARCHIVE':
    case 'SEGMENT_DELETE':
    case 'SDK_KEY_REVOKE':
    case 'MEMBER_REMOVE':
      return 'error';
    case 'ROLLBACK':
    case 'KILL_SWITCH_OFF':
      return 'warning';
    case 'AI_APPLY':
      return 'accent';
    default:
      return 'neutral';
  }
}

const LABELS: Partial<Record<AuditAction, string>> = {
  KILL_SWITCH_ON: 'Kill on',
  KILL_SWITCH_OFF: 'Kill off',
  AI_APPLY: 'AI apply',
  SEGMENT_CREATE: 'Segment +',
  SEGMENT_UPDATE: 'Segment ~',
  SEGMENT_DELETE: 'Segment -',
  SDK_KEY_CREATE: 'Key +',
  SDK_KEY_REVOKE: 'Key -',
  MEMBER_ADD: 'Member +',
  MEMBER_REMOVE: 'Member -',
  SETTINGS_UPDATE: 'Settings',
};

export function actionLabel(action: AuditAction): string {
  return LABELS[action] ?? action.charAt(0) + action.slice(1).toLowerCase();
}

export type AuditRow =
  | { type: 'day'; id: string; label: string }
  | { type: 'entry'; id: string; entry: AuditEntryResponse };

/**
 * Flattens a chronological feed into day headers + entries. A flat list (rather
 * than SectionList) keeps infinite scroll a single onEndReached and lets a new
 * page extend the last day group without re-sectioning.
 */
export function groupByDay(entries: readonly AuditEntryResponse[], now: number = Date.now()): AuditRow[] {
  const rows: AuditRow[] = [];
  let currentDay: string | null = null;
  for (const entry of entries) {
    const key = dayKey(entry.createdAt);
    if (key !== currentDay) {
      currentDay = key;
      rows.push({ type: 'day', id: `day-${key}`, label: dayLabel(entry.createdAt, now) });
    }
    rows.push({ type: 'entry', id: entry.id, entry });
  }
  return rows;
}

/** "v4 → v5" for rollbacks/updates that moved versions. */
export function versionDelta(entry: AuditEntryResponse): string | null {
  if (entry.versionFrom == null && entry.versionTo == null) return null;
  if (entry.versionFrom == null) return `v${entry.versionTo}`;
  if (entry.versionTo == null) return `v${entry.versionFrom}`;
  return `v${entry.versionFrom} → v${entry.versionTo}`;
}
