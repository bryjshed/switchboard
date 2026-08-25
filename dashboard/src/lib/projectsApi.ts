import { apiGet, apiPost } from './apiClient'
import type { Project, SdkKey, SdkKeyCreateRequest, SdkKeyCreated } from '@/types/api'
import { apiDelete } from './apiClient'

export function listProjects(orgId: string): Promise<Project[]> {
  return apiGet<Project[]>(`/api/orgs/${encodeURIComponent(orgId)}/projects`)
}

export function getProject(projectId: string): Promise<Project> {
  return apiGet<Project>(`/api/projects/${encodeURIComponent(projectId)}`)
}


export function listSdkKeys(envId: string): Promise<SdkKey[]> {
  return apiGet<SdkKey[]>(`/api/environments/${encodeURIComponent(envId)}/sdk-keys`)
}

/**
 * The response's `key` is the ONLY time the full SDK key is ever returned — the backend
 * stores a hash. Callers must show it once and must not try to re-fetch it later.
 */
export function createSdkKey(envId: string, body: SdkKeyCreateRequest): Promise<SdkKeyCreated> {
  return apiPost<SdkKeyCreated>(`/api/environments/${encodeURIComponent(envId)}/sdk-keys`, body)
}

export function revokeSdkKey(keyId: string): Promise<void> {
  return apiDelete(`/api/sdk-keys/${encodeURIComponent(keyId)}`)
}
