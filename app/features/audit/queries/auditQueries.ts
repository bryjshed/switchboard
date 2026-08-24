import { infiniteQueryOptions } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';
import type { AuditListResponse } from '@shared/api/types';

import { auditService } from '../services/auditService';

const PAGE_SIZE = 30;

/**
 * Org-wide feed. Keyset pagination: getNextPageParam returns the opaque
 * nextCursor, and its absence ends the list — never a page-number guess.
 */
export function orgAuditOptions(userId: string | undefined, orgId: string | undefined) {
  return infiniteQueryOptions({
    queryKey: queryKeys.audit.list(userId ?? 'anonymous', orgId ?? 'none'),
    queryFn: ({ pageParam }) =>
      auditService.listOrg(orgId as string, { cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuditListResponse) => last.nextCursor,
    enabled: !!userId && !!orgId,
    staleTime: 15_000,
  });
}

/** Project-scoped feed; used when a project filter chip is active so the
 * narrowing happens server-side instead of thinning each loaded page. */
export function projectAuditOptions(userId: string | undefined, projectId: string | undefined) {
  return infiniteQueryOptions({
    queryKey: queryKeys.audit.project(userId ?? 'anonymous', projectId ?? 'none'),
    queryFn: ({ pageParam }) =>
      auditService.listProject(projectId as string, { cursor: pageParam, limit: PAGE_SIZE }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: AuditListResponse) => last.nextCursor,
    enabled: !!userId && !!projectId,
    staleTime: 15_000,
  });
}
