import type { Permission, ScopeType } from '@/types/api'

/**
 * Permission vocabulary for people rather than for the authorizer.
 *
 * `FLAG_ROLLBACK` is a fine name in a policy check and a terrible one in a table a person is
 * reading to decide who to trust with production. Every screen that shows a permission goes
 * through these labels, so the roles matrix and the "you cannot do this" captions describe
 * the same capability in the same words.
 */

export interface PermissionMeta {
  /** Sentence-case capability name. Reads as a thing you can do. */
  label: string
  /** One line of what it actually allows, for a tooltip or a matrix legend. */
  description: string
  /** Groups the matrix columns; also the order groups appear. */
  group: PermissionGroup
}

export type PermissionGroup = 'Flags' | 'Review' | 'Administration'

export const PERMISSION_GROUPS: readonly PermissionGroup[] = ['Flags', 'Review', 'Administration']

export const PERMISSION_META: Record<Permission, PermissionMeta> = {
  FLAG_READ: {
    label: 'View flags',
    description: 'See flags, their targeting and their history.',
    group: 'Flags',
  },
  FLAG_WRITE: {
    label: 'Edit targeting',
    description: 'Change rules, rollouts and individual targets, and turn a flag on or off.',
    group: 'Flags',
  },
  FLAG_KILL: {
    label: 'Use the kill switch',
    description: 'Serve the off variation to everyone immediately, without touching targeting.',
    group: 'Flags',
  },
  FLAG_ROLLBACK: {
    label: 'Roll back',
    description: 'Restore an earlier version of a flag as a new version.',
    group: 'Flags',
  },
  SEGMENT_WRITE: {
    label: 'Edit segments',
    description: 'Create and change the reusable audience definitions rules point at.',
    group: 'Flags',
  },
  APPROVE_CHANGES: {
    label: 'Approve changes',
    description: 'Approve or decline change requests in environments that require review.',
    group: 'Review',
  },
  VIEW_AUDIT: {
    label: 'Read the audit log',
    description: 'See who changed what, and when.',
    group: 'Review',
  },
  MANAGE_MEMBERS: {
    label: 'Manage people and roles',
    description: 'Add and remove members, and grant or revoke roles at any scope.',
    group: 'Administration',
  },
  MANAGE_SDK_KEYS: {
    label: 'Manage SDK keys',
    description: 'Issue and revoke the keys applications authenticate with.',
    group: 'Administration',
  },
  MANAGE_PROJECTS: {
    label: 'Manage projects',
    description: 'Create and configure projects.',
    group: 'Administration',
  },
  MANAGE_ENVIRONMENTS: {
    label: 'Manage environments',
    description: 'Create environments and set their approval policy.',
    group: 'Administration',
  },
  MANAGE_SETTINGS: {
    label: 'Manage organization settings',
    description: 'Change org-wide settings, including the AI switches.',
    group: 'Administration',
  },
}

/** Humanized name; falls back to the raw enum for a permission this build has not seen. */
export function permissionLabel(permission: Permission | string): string {
  return PERMISSION_META[permission as Permission]?.label ?? String(permission)
}

export function permissionDescription(permission: Permission | string): string {
  return PERMISSION_META[permission as Permission]?.description ?? ''
}

const SCOPE_LABELS: Record<ScopeType, string> = {
  ORG: 'organization',
  PROJECT: 'project',
  ENVIRONMENT: 'environment',
}

export function scopeTypeLabel(scopeType: ScopeType): string {
  return SCOPE_LABELS[scopeType] ?? String(scopeType)
}

/**
 * "the production environment", "the storefront-app project", "the whole organization" —
 * the phrase a caption uses when it has to name where a grant applies. `name` is the
 * resolved project/environment name; without one the caller only has a uuid, and saying
 * "an environment" beats printing it.
 */
export function scopePhrase(scopeType: ScopeType, name?: string | null): string {
  if (scopeType === 'ORG') return 'the whole organization'
  if (!name) return scopeType === 'PROJECT' ? 'a project' : 'an environment';
  return `the ${name} ${SCOPE_LABELS[scopeType]}`
}

/**
 * Sentence for a control the viewer may not use. Deliberately names the capability rather
 * than the enum, and says who to ask, because "FLAG_WRITE required" tells a person nothing
 * they can act on.
 */
export function missingPermissionReason(
  permission: Permission,
  scopeType: ScopeType | null,
  scopeName?: string | null,
): string {
  const where = scopeType ? ` in ${scopePhrase(scopeType, scopeName)}` : ''
  return `You do not have permission to ${permissionLabel(permission).toLowerCase()}${where}. Ask an owner or admin for a role that grants it.`
}
