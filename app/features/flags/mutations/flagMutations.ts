import { useMutation, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { queryKeys } from '@shared/api/queryKeys';
import { haptic } from '@shared/haptics';
import type {
  FlagCreateRequest,
  FlagDetailResponse,
  FlagEnvConfigResponse,
  FlagListResponse,
  FlagTargetingConfig,
} from '@shared/api/types';

import { flagService } from '../services/flagService';
import { rampPercentage } from '../lib/targeting';

export interface FlagMutationScope {
  userId: string | undefined;
  orgId: string | undefined;
  projectId: string | undefined;
}

/** Every cache a flag write can invalidate: the per-env lists, the flag detail,
 * that env's version history, and both audit feeds. */
function invalidateFlagWrite(
  client: QueryClient,
  { userId, orgId, projectId }: FlagMutationScope,
  flagKey: string,
  envKey?: string,
): void {
  if (!userId || !projectId) return;
  void client.invalidateQueries({ queryKey: queryKeys.flags.list(userId, projectId) });
  void client.invalidateQueries({ queryKey: queryKeys.flags.detail(userId, projectId, flagKey) });
  if (envKey) {
    void client.invalidateQueries({
      queryKey: queryKeys.flags.versions(userId, projectId, flagKey, envKey),
    });
  }
  void client.invalidateQueries({ queryKey: queryKeys.audit.project(userId, projectId) });
  if (orgId) void client.invalidateQueries({ queryKey: queryKeys.audit.list(userId, orgId) });
}

type ListSnapshot = [readonly unknown[], FlagListResponse | undefined][];

/** Applies `patch` to one flag's env summary across every cached per-env list. */
function patchListCaches(
  client: QueryClient,
  scope: FlagMutationScope,
  flagKey: string,
  envKey: string,
  patch: (env: FlagListResponse['items'][number]['environments'][number]) => FlagListResponse['items'][number]['environments'][number],
): ListSnapshot {
  const { userId, projectId } = scope;
  if (!userId || !projectId) return [];
  const key = queryKeys.flags.list(userId, projectId);
  const snapshot = client.getQueriesData<FlagListResponse>({ queryKey: key });
  client.setQueriesData<FlagListResponse>({ queryKey: key }, (previous) => {
    if (!previous) return previous;
    return {
      ...previous,
      items: previous.items.map((item) =>
        item.key === flagKey
          ? {
              ...item,
              environments: item.environments.map((env) => (env.envKey === envKey ? patch(env) : env)),
            }
          : item,
      ),
    };
  });
  return snapshot;
}

function patchDetailCache(
  client: QueryClient,
  scope: FlagMutationScope,
  flagKey: string,
  envKey: string,
  patch: (env: FlagDetailResponse['envConfigs'][number]) => FlagDetailResponse['envConfigs'][number],
): FlagDetailResponse | undefined {
  const { userId, projectId } = scope;
  if (!userId || !projectId) return undefined;
  const key = queryKeys.flags.detail(userId, projectId, flagKey);
  const snapshot = client.getQueryData<FlagDetailResponse>(key);
  client.setQueryData<FlagDetailResponse>(key, (previous) =>
    previous
      ? {
          ...previous,
          envConfigs: previous.envConfigs.map((env) => (env.envKey === envKey ? patch(env) : env)),
        }
      : previous,
  );
  return snapshot;
}

function restore(
  client: QueryClient,
  lists: ListSnapshot,
  detailKey: readonly unknown[] | null,
  detail: FlagDetailResponse | undefined,
): void {
  lists.forEach(([key, data]) => client.setQueryData(key, data));
  if (detailKey) client.setQueryData(detailKey, detail);
}

export interface KillSwitchVars {
  flagKey: string;
  envKey: string;
  active: boolean;
  reason?: string;
}

/**
 * One-tap kill switch. The pill flips immediately in every cached list and in
 * the flag detail; a failure restores the exact pre-mutation snapshots and
 * rethrows so the caller can surface the message.
 */
export function useKillSwitchMutation(scope: FlagMutationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ flagKey, envKey, active, reason }: KillSwitchVars) =>
      flagService.setKillSwitch(scope.projectId as string, flagKey, envKey, { active, reason }),

    onMutate: async ({ flagKey, envKey, active }) => {
      if (!scope.userId || !scope.projectId) return undefined;
      const detailKey = queryKeys.flags.detail(scope.userId, scope.projectId, flagKey);
      await client.cancelQueries({
        queryKey: queryKeys.flags.list(scope.userId, scope.projectId),
      });
      await client.cancelQueries({ queryKey: detailKey });
      const lists = patchListCaches(client, scope, flagKey, envKey, (env) => ({
        ...env,
        killSwitchActive: active,
      }));
      const detail = patchDetailCache(client, scope, flagKey, envKey, (env) => ({
        ...env,
        killSwitchActive: active,
      }));
      return { lists, detailKey, detail };
    },

    onError: (error, _vars, context) => {
      console.warn('[flags] kill switch failed', error);
      if (context) restore(client, context.lists, context.detailKey, context.detail);
    },

    onSuccess: () => haptic('success'),

    onSettled: (_data, _error, { flagKey, envKey }) =>
      invalidateFlagWrite(client, scope, flagKey, envKey),
  });
}

export interface EnvConfigVars {
  flagKey: string;
  envKey: string;
  enabled: boolean;
  config: FlagTargetingConfig;
  expectedVersion: number;
  comment?: string;
}

/**
 * Full targeting write (enabled toggle, ramp, targeting editor save). Optimistic
 * on the summary fields the list shows; a 409 rolls the cache back and the
 * caller refetches to pick up the newer version.
 */
export function useEnvConfigMutation(scope: FlagMutationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ flagKey, envKey, enabled, config, expectedVersion, comment }: EnvConfigVars) =>
      flagService.putEnvConfig(scope.projectId as string, flagKey, envKey, {
        enabled,
        config,
        expectedVersion,
        comment,
      }),

    onMutate: async ({ flagKey, envKey, enabled, config }) => {
      if (!scope.userId || !scope.projectId) return undefined;
      const detailKey = queryKeys.flags.detail(scope.userId, scope.projectId, flagKey);
      await client.cancelQueries({
        queryKey: queryKeys.flags.list(scope.userId, scope.projectId),
      });
      await client.cancelQueries({ queryKey: detailKey });
      const percentage = rampPercentage(config);
      const lists = patchListCaches(client, scope, flagKey, envKey, (env) => ({
        ...env,
        enabled,
        rolloutPercentage: percentage ?? undefined,
      }));
      const detail = patchDetailCache(client, scope, flagKey, envKey, (env) => ({
        ...env,
        enabled,
        config,
      }));
      return { lists, detailKey, detail };
    },

    onError: (error, _vars, context) => {
      console.warn('[flags] env config write failed', error);
      if (context) restore(client, context.lists, context.detailKey, context.detail);
    },

    onSuccess: (data: FlagEnvConfigResponse, { flagKey }) => {
      haptic('success');
      // Adopt the server's new version immediately so a second write in the
      // same session sends a fresh expectedVersion instead of 409ing.
      if (scope.userId && scope.projectId) {
        patchDetailCache(client, scope, flagKey, data.envKey, () => data);
      }
    },

    onSettled: (_data, _error, { flagKey, envKey }) =>
      invalidateFlagWrite(client, scope, flagKey, envKey),
  });
}

export interface RollbackVars {
  flagKey: string;
  envKey: string;
  toVersion: number;
  reason?: string;
}

/** Rollback rewrites the whole config server-side, so there is nothing safe to
 * predict locally — it invalidates rather than guessing. */
export function useRollbackMutation(scope: FlagMutationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ flagKey, envKey, toVersion, reason }: RollbackVars) =>
      flagService.rollback(scope.projectId as string, flagKey, envKey, { toVersion, reason }),
    onError: (error) => {
      console.warn('[flags] rollback failed', error);
    },
    onSuccess: () => haptic('success'),
    onSettled: (_data, _error, { flagKey, envKey }) =>
      invalidateFlagWrite(client, scope, flagKey, envKey),
  });
}

/** Creates a flag; the server seeds one config per environment. */
export function useCreateFlagMutation(scope: FlagMutationScope) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (body: FlagCreateRequest) =>
      flagService.create(scope.projectId as string, body),
    onError: (error) => {
      console.warn('[flags] create failed', error);
    },
    onSuccess: (flag: FlagDetailResponse) => {
      haptic('success');
      if (scope.userId && scope.projectId) {
        client.setQueryData(
          queryKeys.flags.detail(scope.userId, scope.projectId, flag.key),
          flag,
        );
      }
      invalidateFlagWrite(client, scope, flag.key);
    },
  });
}
