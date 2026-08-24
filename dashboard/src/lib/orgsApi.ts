import { apiDelete, apiGet, apiPost, apiPut } from './apiClient'
import type {
  Org,
  OrgMember,
  OrgMemberAddRequest,
  OrgSettings,
  OrgSettingsUpdateRequest,
  User,
} from '@/types/api'

export function getMe(): Promise<User> {
  return apiGet<User>('/api/users/me')
}

export function listOrgs(): Promise<Org[]> {
  return apiGet<Org[]>('/api/orgs')
}

export function getOrg(orgId: string): Promise<Org> {
  return apiGet<Org>(`/api/orgs/${encodeURIComponent(orgId)}`)
}

export function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  return apiGet<OrgMember[]>(`/api/orgs/${encodeURIComponent(orgId)}/members`)
}

/** OWNER-only. 404 when no user with that email exists yet. */
export function addOrgMember(orgId: string, body: OrgMemberAddRequest): Promise<OrgMember> {
  return apiPost<OrgMember>(`/api/orgs/${encodeURIComponent(orgId)}/members`, body)
}

export function removeOrgMember(orgId: string, userId: string): Promise<void> {
  return apiDelete(
    `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
  )
}

// Org settings carry the AI switches (aiEnabled / autoRollbackEnabled / autoOptimizeEnabled)
// plus staleFlagWeeks. The Settings page renders a placeholder section for these; the AI
// screens are a separate workstream.
export function getOrgSettings(orgId: string): Promise<OrgSettings> {
  return apiGet<OrgSettings>(`/api/orgs/${encodeURIComponent(orgId)}/settings`)
}

export function updateOrgSettings(
  orgId: string,
  body: OrgSettingsUpdateRequest,
): Promise<OrgSettings> {
  return apiPut<OrgSettings>(`/api/orgs/${encodeURIComponent(orgId)}/settings`, body)
}
