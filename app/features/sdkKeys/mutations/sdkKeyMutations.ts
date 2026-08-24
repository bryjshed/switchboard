import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';
import { haptic } from '@shared/haptics';
import type { SdkKeyResponse } from '@shared/api/types';

import { sdkKeyService } from '../services/sdkKeyService';

export interface SdkKeyScope {
  userId: string | undefined;
  orgId: string | undefined;
  envId: string | undefined;
}

export function useCreateSdkKeyMutation({ userId, orgId, envId }: SdkKeyScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (label: string | undefined) =>
      sdkKeyService.create(envId as string, { label: label?.trim() || undefined }),
    onError: (error) => {
      console.warn('[sdk-keys] create failed', error);
    },
    onSuccess: () => {
      haptic('success');
      if (userId && envId) {
        void client.invalidateQueries({ queryKey: queryKeys.sdkKeys.list(userId, envId) });
      }
      if (userId && orgId) {
        void client.invalidateQueries({ queryKey: queryKeys.audit.list(userId, orgId) });
      }
    },
  });
}

/**
 * Revoke. Optimistically stamps revokedAt so the row greys out immediately;
 * a failure restores the exact list snapshot.
 */
export function useRevokeSdkKeyMutation({ userId, orgId, envId }: SdkKeyScope) {
  const client = useQueryClient();
  const listKey = userId && envId ? queryKeys.sdkKeys.list(userId, envId) : null;
  return useMutation({
    mutationFn: (keyId: string) => sdkKeyService.revoke(keyId),

    onMutate: async (keyId: string) => {
      if (!listKey) return undefined;
      await client.cancelQueries({ queryKey: listKey });
      const snapshot = client.getQueryData<SdkKeyResponse[]>(listKey);
      client.setQueryData<SdkKeyResponse[]>(listKey, (previous) =>
        previous?.map((k) => (k.id === keyId ? { ...k, revokedAt: new Date().toISOString() } : k)),
      );
      return { snapshot };
    },

    onError: (error, _keyId, context) => {
      console.warn('[sdk-keys] revoke failed', error);
      if (listKey && context) client.setQueryData(listKey, context.snapshot);
    },

    onSuccess: () => haptic('success'),

    onSettled: () => {
      if (listKey) void client.invalidateQueries({ queryKey: listKey });
      if (userId && orgId) {
        void client.invalidateQueries({ queryKey: queryKeys.audit.list(userId, orgId) });
      }
    },
  });
}
