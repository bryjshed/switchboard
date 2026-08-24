import { queryOptions } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';

import { flagService } from '../services/flagService';

export interface FlagsListParams {
  userId: string | undefined;
  projectId: string | undefined;
}

/**
 * Flags for a project. The response is env-agnostic — each item carries every
 * environment's summary — so the cache is keyed by project alone and the env
 * switcher only picks which summary each card renders.
 */
export function flagsListOptions({ userId, projectId }: FlagsListParams) {
  return queryOptions({
    queryKey: queryKeys.flags.list(userId ?? 'anonymous', projectId ?? 'none'),
    queryFn: () => flagService.list({ projectId: projectId as string }),
    enabled: !!userId && !!projectId,
    staleTime: 15_000,
  });
}

export function flagDetailOptions(
  userId: string | undefined,
  projectId: string | undefined,
  flagKey: string | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.flags.detail(userId ?? 'anonymous', projectId ?? 'none', flagKey ?? 'none'),
    queryFn: () => flagService.get(projectId as string, flagKey as string),
    enabled: !!userId && !!projectId && !!flagKey,
    staleTime: 10_000,
  });
}

export function flagVersionsOptions(
  userId: string | undefined,
  projectId: string | undefined,
  flagKey: string | undefined,
  envKey: string | undefined,
) {
  return queryOptions({
    queryKey: queryKeys.flags.versions(
      userId ?? 'anonymous',
      projectId ?? 'none',
      flagKey ?? 'none',
      envKey ?? 'none',
    ),
    queryFn: () => flagService.listVersions(projectId as string, flagKey as string, envKey as string),
    enabled: !!userId && !!projectId && !!flagKey && !!envKey,
    staleTime: 10_000,
  });
}
