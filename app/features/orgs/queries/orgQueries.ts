import { queryOptions } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';

import { orgService } from '../services/orgService';

/** Orgs the user belongs to. /me.memberships covers the common case; this is
 * for the switcher's canonical list (roles + createdAt). */
export function orgsListOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.orgs.list(userId ?? 'anonymous'),
    queryFn: () => orgService.listOrgs(),
    enabled: !!userId,
    staleTime: 60_000,
  });
}

export function orgMembersOptions(userId: string | undefined, orgId: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.orgs.members(userId ?? 'anonymous', orgId ?? 'none'),
    queryFn: () => orgService.listMembers(orgId as string),
    enabled: !!userId && !!orgId,
    staleTime: 60_000,
  });
}

export function orgSettingsOptions(userId: string | undefined, orgId: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.orgs.settings(userId ?? 'anonymous', orgId ?? 'none'),
    queryFn: () => orgService.getSettings(orgId as string),
    enabled: !!userId && !!orgId,
    staleTime: 60_000,
  });
}

/** Projects for an org. Environments ride along on each project. */
export function projectsListOptions(userId: string | undefined, orgId: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.projects.list(userId ?? 'anonymous', orgId ?? 'none'),
    queryFn: () => orgService.listProjects(orgId as string),
    enabled: !!userId && !!orgId,
    staleTime: 60_000,
  });
}

export function projectDetailOptions(userId: string | undefined, projectId: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.projects.detail(userId ?? 'anonymous', projectId ?? 'none'),
    queryFn: () => orgService.getProject(projectId as string),
    enabled: !!userId && !!projectId,
    staleTime: 60_000,
  });
}
