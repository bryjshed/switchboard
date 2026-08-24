import { describe, expect, it } from 'vitest'
import { auditActionMeta, groupByDay } from '@/lib/auditDisplay'
import type { AuditAction, AuditEntry } from '@/types/api'

function entry(id: string, createdAt: string, action: AuditAction = 'UPDATE'): AuditEntry {
  return { id, orgId: 'org', action, actor: 'alice@switchboard.dev', createdAt }
}

/** Local midnight on a given day, so grouping tests do not depend on the runner's timezone. */
function localIso(daysAgo: number, hour = 12): string {
  const date = new Date()
  date.setDate(date.getDate() - daysAgo)
  date.setHours(hour, 0, 0, 0)
  return date.toISOString()
}

describe('auditActionMeta', () => {
  it('colours the create family as ok', () => {
    expect(auditActionMeta('CREATE').variant).toBe('ok')
    expect(auditActionMeta('SEGMENT_CREATE').variant).toBe('ok')
    expect(auditActionMeta('KILL_SWITCH_OFF').variant).toBe('ok')
  })

  it('colours a kill switch as destructive', () => {
    expect(auditActionMeta('KILL_SWITCH_ON').variant).toBe('destructive')
  })

  it('colours a rollback as a warning', () => {
    expect(auditActionMeta('ROLLBACK').variant).toBe('warning')
  })

  it('marks AI_APPLY as automatic and gives it its own colour', () => {
    const meta = auditActionMeta('AI_APPLY')
    expect(meta.automatic).toBe(true)
    expect(meta.variant).toBe('info')
    expect(meta.label).toBe('applied by AI')
  })

  it('treats every human action as not automatic', () => {
    const human: AuditAction[] = ['CREATE', 'UPDATE', 'ROLLBACK', 'KILL_SWITCH_ON', 'ARCHIVE']
    for (const action of human) expect(auditActionMeta(action).automatic).toBe(false)
  })

  it('does not blank out on an action the spec grows later', () => {
    const meta = auditActionMeta('SOMETHING_NEW' as AuditAction)
    expect(meta.label).toBe('something new')
    expect(meta.variant).toBe('outline')
  })
})

describe('groupByDay', () => {
  it('labels the current and previous local day in words', () => {
    const groups = groupByDay([entry('a', localIso(0)), entry('b', localIso(1))])
    expect(groups.map((g) => g.label)).toEqual(['Today', 'Yesterday'])
  })

  it('keeps entries from the same day in one group, in the order given', () => {
    const groups = groupByDay([
      entry('a', localIso(0, 14)),
      entry('b', localIso(0, 9)),
      entry('c', localIso(2)),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0].items.map((i) => i.id)).toEqual(['a', 'b'])
    expect(groups[1].items.map((i) => i.id)).toEqual(['c'])
  })

  it('gives an older day an absolute label rather than "N days ago"', () => {
    const groups = groupByDay([entry('a', localIso(5))])
    expect(groups[0].label).not.toBe('Today')
    expect(groups[0].label).not.toBe('Yesterday')
    expect(groups[0].label.length).toBeGreaterThan(0)
  })

  it('returns nothing for an empty page', () => {
    expect(groupByDay([])).toEqual([])
  })

  it('does not crash on an unparseable timestamp', () => {
    const groups = groupByDay([entry('a', 'not-a-date')])
    expect(groups).toHaveLength(1)
    expect(groups[0].day).toBe('unknown')
  })
})
