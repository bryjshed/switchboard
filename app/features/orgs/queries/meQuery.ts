import { queryOptions } from '@tanstack/react-query';

import { api } from '@shared/api/client';
import { queryKeys } from '@shared/api/queryKeys';
import type { UserResponse } from '@shared/api/types';

/**
 * Current user + memberships. userId comes from the auth store; the key is
 * user-scoped so an account switch never reads a stale cache.
 */
export function meQueryOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.me(userId ?? 'anonymous'),
    queryFn: () => api.get<UserResponse>('/api/users/me'),
    enabled: !!userId,
    staleTime: 60_000,
  });
}
