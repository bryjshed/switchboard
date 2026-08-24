import { api } from '@shared/api/client';
import type { SdkKeyCreatedResponse, SdkKeyCreateRequest, SdkKeyResponse } from '@shared/api/types';

/** SDK keys are per environment. The full key exists only in the create
 * response — every later read returns the prefix. */
export const sdkKeyService = {
  list: (envId: string) => api.get<SdkKeyResponse[]>(`/api/environments/${envId}/sdk-keys`),

  create: (envId: string, body: SdkKeyCreateRequest) =>
    api.post<SdkKeyCreatedResponse>(`/api/environments/${envId}/sdk-keys`, body),

  revoke: (keyId: string) => api.delete<void>(`/api/sdk-keys/${keyId}`),
};
