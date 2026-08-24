import { api } from '@shared/api/client';
import type { AuditListResponse } from '@shared/api/types';

export interface AuditPageParams {
  cursor?: string;
  limit?: number;
}

function qs({ cursor, limit }: AuditPageParams): string {
  const parts: string[] = [];
  if (cursor) parts.push(`cursor=${encodeURIComponent(cursor)}`);
  if (limit) parts.push(`limit=${limit}`);
  return parts.length ? `?${parts.join('&')}` : '';
}

/** Keyset-paginated audit feeds. `nextCursor` is opaque — pass it straight back. */
export const auditService = {
  listOrg: (orgId: string, params: AuditPageParams = {}) =>
    api.get<AuditListResponse>(`/api/orgs/${orgId}/audit${qs(params)}`),

  listProject: (projectId: string, params: AuditPageParams = {}) =>
    api.get<AuditListResponse>(`/api/projects/${projectId}/audit${qs(params)}`),
};
