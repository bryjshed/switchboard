import { useMutation, useQueryClient } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';
import { haptic } from '@shared/haptics';
import type { OrgSettingsResponse, OrgSettingsUpdateRequest } from '@shared/api/types';

import { orgService } from '../services/orgService';

export interface OrgSettingsScope {
  userId: string | undefined;
  orgId: string | undefined;
}

/**
 * Org settings write. Optimistic because these are switches: the thumb has to
 * move on tap or it reads as broken. A failure (403 for a member, network) puts
 * the previous settings back exactly and rethrows so the caller can explain.
 */
export function useOrgSettingsMutation({ userId, orgId }: OrgSettingsScope) {
  const client = useQueryClient();
  const key = queryKeys.orgs.settings(userId ?? 'anonymous', orgId ?? 'none');

  return useMutation({
    mutationFn: (body: OrgSettingsUpdateRequest) =>
      orgService.updateSettings(orgId as string, body),

    onMutate: async (body) => {
      if (!userId || !orgId) return undefined;
      await client.cancelQueries({ queryKey: key });
      const snapshot = client.getQueryData<OrgSettingsResponse>(key);
      client.setQueryData<OrgSettingsResponse>(key, (previous) =>
        previous ? { ...previous, ...stripUndefined(body) } : previous,
      );
      return { snapshot };
    },

    onError: (error, _vars, context) => {
      console.warn('[orgs] settings write failed', error);
      if (context) client.setQueryData(key, context.snapshot);
    },

    onSuccess: (settings: OrgSettingsResponse) => {
      haptic('success');
      client.setQueryData(key, settings);
    },

    onSettled: () => {
      if (userId && orgId) void client.invalidateQueries({ queryKey: key });
    },
  });
}

/** The response has no notificationWebhookUrl field, so only known keys merge. */
function stripUndefined(body: OrgSettingsUpdateRequest): Partial<OrgSettingsResponse> {
  const out: Partial<OrgSettingsResponse> = {};
  if (body.aiEnabled !== undefined) out.aiEnabled = body.aiEnabled;
  if (body.autoRollbackEnabled !== undefined) out.autoRollbackEnabled = body.autoRollbackEnabled;
  if (body.autoOptimizeEnabled !== undefined) out.autoOptimizeEnabled = body.autoOptimizeEnabled;
  if (body.staleFlagWeeks !== undefined) out.staleFlagWeeks = body.staleFlagWeeks;
  return out;
}
