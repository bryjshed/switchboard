import { api } from '@shared/api/client';
import type {
  FlagCreateRequest,
  FlagDetailResponse,
  FlagEnvConfigResponse,
  FlagEnvConfigUpdateRequest,
  FlagListResponse,
  FlagUpdateRequest,
  FlagVersionListResponse,
  FlagVersionResponse,
  KillSwitchRequest,
  RollbackRequest,
} from '@shared/api/types';

export interface ListFlagsParams {
  projectId: string;
  /** Server-side search over key/name. */
  query?: string;
  tag?: string;
  cursor?: string;
  limit?: number;
}

function qs(params: Record<string, string | number | undefined>): string {
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

const base = (projectId: string, flagKey: string) =>
  `/api/projects/${projectId}/flags/${encodeURIComponent(flagKey)}`;

const envBase = (projectId: string, flagKey: string, envKey: string) =>
  `${base(projectId, flagKey)}/environments/${encodeURIComponent(envKey)}`;

/**
 * Flag reads and writes. The list carries per-environment summaries, so the
 * flags screen needs exactly one request regardless of how many envs a project
 * has — the env switcher only picks which summary to render.
 */
export const flagService = {
  list: ({ projectId, query, tag, cursor, limit }: ListFlagsParams) =>
    api.get<FlagListResponse>(
      `/api/projects/${projectId}/flags${qs({ query, tag, cursor, limit })}`,
    ),

  get: (projectId: string, flagKey: string) =>
    api.get<FlagDetailResponse>(base(projectId, flagKey)),

  create: (projectId: string, body: FlagCreateRequest) =>
    api.post<FlagDetailResponse>(`/api/projects/${projectId}/flags`, body),

  update: (projectId: string, flagKey: string, body: FlagUpdateRequest) =>
    api.patch<FlagDetailResponse>(base(projectId, flagKey), body),

  archive: (projectId: string, flagKey: string) =>
    api.delete<void>(base(projectId, flagKey)),

  /** Full config write; 409 when expectedVersion is stale. */
  putEnvConfig: (
    projectId: string,
    flagKey: string,
    envKey: string,
    body: FlagEnvConfigUpdateRequest,
  ) => api.put<FlagEnvConfigResponse>(envBase(projectId, flagKey, envKey), body),

  /** One-tap kill switch; never version-conflicts. */
  setKillSwitch: (projectId: string, flagKey: string, envKey: string, body: KillSwitchRequest) =>
    api.post<FlagEnvConfigResponse>(`${envBase(projectId, flagKey, envKey)}/kill-switch`, body),

  listVersions: (
    projectId: string,
    flagKey: string,
    envKey: string,
    cursor?: string,
    limit?: number,
  ) =>
    api.get<FlagVersionListResponse>(
      `${envBase(projectId, flagKey, envKey)}/versions${qs({ cursor, limit })}`,
    ),

  getVersion: (projectId: string, flagKey: string, envKey: string, versionNumber: number) =>
    api.get<FlagVersionResponse>(
      `${envBase(projectId, flagKey, envKey)}/versions/${versionNumber}`,
    ),

  rollback: (projectId: string, flagKey: string, envKey: string, body: RollbackRequest) =>
    api.post<FlagEnvConfigResponse>(`${envBase(projectId, flagKey, envKey)}/rollback`, body),
};
