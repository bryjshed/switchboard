import { apiDelete, apiGet, apiPost } from './apiClient'
import type {
  MyPermissions,
  Role,
  RoleAssignment,
  RoleAssignmentCreateRequest,
  RoleAssignmentListResponse,
  RoleListResponse,
  ScopeType,
} from '@/types/api'

/** Every assignable role and the permissions it bundles. Org-independent. */
export async function listRoles(): Promise<Role[]> {
  const res = await apiGet<RoleListResponse>('/api/roles')
  return res.items
}

/**
 * One of `orgId` / `projectId` / `envId`. The narrowest scope wins, and the answer is the
 * UNION of the roles the caller holds there and at every scope containing it — so asking at
 * the environment returns the org-level grants too, which is why the dashboard asks once,
 * at the narrowest scope it has, rather than three times.
 */
export type PermissionScopeQuery =
  | { orgId: string }
  | { projectId: string }
  | { envId: string }

export function getMyPermissions(scope: PermissionScopeQuery): Promise<MyPermissions> {
  const search = new URLSearchParams(scope as Record<string, string>)
  return apiGet<MyPermissions>(`/api/users/me/permissions?${search.toString()}`)
}

export interface ListRoleAssignmentsParams {
  scopeType?: ScopeType
  scopeId?: string
}

/** Everything granted anywhere under this org. Requires MANAGE_MEMBERS. */
export async function listRoleAssignments(
  orgId: string,
  params: ListRoleAssignmentsParams = {},
): Promise<RoleAssignment[]> {
  const search = new URLSearchParams()
  if (params.scopeType) search.set('scopeType', params.scopeType)
  if (params.scopeId) search.set('scopeId', params.scopeId)
  const qs = search.toString()
  const res = await apiGet<RoleAssignmentListResponse>(
    `/api/orgs/${encodeURIComponent(orgId)}/role-assignments${qs ? `?${qs}` : ''}`,
  )
  return res.items
}

/**
 * Upserts on (user, scope): granting again at the same scope REPLACES the role held there
 * rather than adding a second one. Roles at different scopes stack, and their permissions
 * union.
 */
export function grantRole(
  orgId: string,
  body: RoleAssignmentCreateRequest,
): Promise<RoleAssignment> {
  return apiPost<RoleAssignment>(`/api/orgs/${encodeURIComponent(orgId)}/role-assignments`, body)
}

export function revokeRole(orgId: string, assignmentId: string): Promise<void> {
  return apiDelete(
    `/api/orgs/${encodeURIComponent(orgId)}/role-assignments/${encodeURIComponent(assignmentId)}`,
  )
}
