import { apiDelete, apiGet, apiPost, apiPut } from './apiClient'
import type {
  Org,
  OrgCreateRequest,
  OrgInvitation,
  OrgInvitationCreateRequest,
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

/**
 * Creates an org with the caller as OWNER. Whether this is allowed depends on the instance's
 * `switchboard.org-creation` policy - `profile.canCreateOrg` says in advance, so the UI only
 * offers it when it will succeed. Under `bootstrap` only the very first org may be created.
 */
export function createOrg(body: OrgCreateRequest): Promise<Org> {
  return apiPost<Org>('/api/orgs', body)
}

export function getOrg(orgId: string): Promise<Org> {
  return apiGet<Org>(`/api/orgs/${encodeURIComponent(orgId)}`)
}

export function listOrgMembers(orgId: string): Promise<OrgMember[]> {
  return apiGet<OrgMember[]>(`/api/orgs/${encodeURIComponent(orgId)}/members`)
}

/**
 * Adds an EXISTING user directly; 404 when nobody with that email has signed in yet. The
 * dashboard invites instead (`createInvitation`), which covers both cases.
 */
export function addOrgMember(orgId: string, body: OrgMemberAddRequest): Promise<OrgMember> {
  return apiPost<OrgMember>(`/api/orgs/${encodeURIComponent(orgId)}/members`, body)
}

export function removeOrgMember(orgId: string, userId: string): Promise<void> {
  return apiDelete(
    `/api/orgs/${encodeURIComponent(orgId)}/members/${encodeURIComponent(userId)}`,
  )
}

/** Pending invitations only, oldest first. Needs MANAGE_MEMBERS. */
export function listInvitations(orgId: string): Promise<OrgInvitation[]> {
  return apiGet<OrgInvitation[]>(`/api/orgs/${encodeURIComponent(orgId)}/invitations`)
}

/**
 * Invites an email address. The returned `status` says what actually happened:
 * - `ACCEPTED`: that person already had an account and is a member now.
 * - `PENDING`: they join automatically the first time they sign in with that (verified) email.
 *
 * No email is sent. 409 when a pending invitation for that address exists, or they are
 * already a member.
 */
export function createInvitation(
  orgId: string,
  body: OrgInvitationCreateRequest,
): Promise<OrgInvitation> {
  return apiPost<OrgInvitation>(`/api/orgs/${encodeURIComponent(orgId)}/invitations`, body)
}

export function revokeInvitation(orgId: string, invitationId: string): Promise<void> {
  return apiDelete(
    `/api/orgs/${encodeURIComponent(orgId)}/invitations/${encodeURIComponent(invitationId)}`,
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
