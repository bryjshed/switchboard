import { queryOptions } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';

import { sdkKeyService } from '../services/sdkKeyService';

export function sdkKeysOptions(userId: string | undefined, envId: string | undefined) {
  return queryOptions({
    queryKey: queryKeys.sdkKeys.list(userId ?? 'anonymous', envId ?? 'none'),
    queryFn: () => sdkKeyService.list(envId as string),
    enabled: !!userId && !!envId,
    staleTime: 30_000,
  });
}
