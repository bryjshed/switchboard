import { api } from '@shared/api/client';
import type {
  OrgMemberResponse,
  OrgResponse,
  OrgSettingsResponse,
  OrgSettingsUpdateRequest,
  ProjectResponse,
  UserResponse,
} from '@shared/api/types';

/**
 * Org/project reads. Thin, typed wrappers over the api client — one place per
 * URL so screens never hand-build paths. Errors bubble as ApiClientError.
 */
export const orgService = {
  getMe: () => api.get<UserResponse>('/api/users/me'),

  listOrgs: () => api.get<OrgResponse[]>('/api/orgs'),

  getOrg: (orgId: string) => api.get<OrgResponse>(`/api/orgs/${orgId}`),

  listMembers: (orgId: string) => api.get<OrgMemberResponse[]>(`/api/orgs/${orgId}/members`),

  getSettings: (orgId: string) => api.get<OrgSettingsResponse>(`/api/orgs/${orgId}/settings`),

  /** OWNER only; a member's write comes back 403 FORBIDDEN. */
  updateSettings: (orgId: string, body: OrgSettingsUpdateRequest) =>
    api.put<OrgSettingsResponse>(`/api/orgs/${orgId}/settings`, body),

  /** Environments arrive embedded on each project — no second round trip. */
  listProjects: (orgId: string) => api.get<ProjectResponse[]>(`/api/orgs/${orgId}/projects`),

  getProject: (projectId: string) => api.get<ProjectResponse>(`/api/projects/${projectId}`),
};
