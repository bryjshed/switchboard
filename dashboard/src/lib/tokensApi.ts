import { apiDelete, apiGet, apiPost } from '@/lib/apiClient'
import type {
  PersonalAccessToken,
  PersonalAccessTokenCreateRequest,
  PersonalAccessTokenCreated,
} from '@/types/api'

/**
 * Personal access tokens. Always the caller's own — the API has no notion of reading somebody
 * else's, which is why none of these take a user id.
 */

export function listMyTokens(): Promise<PersonalAccessToken[]> {
  return apiGet<PersonalAccessToken[]>('/api/users/me/tokens')
}

export function createMyToken(
  body: PersonalAccessTokenCreateRequest,
): Promise<PersonalAccessTokenCreated> {
  return apiPost<PersonalAccessTokenCreated>('/api/users/me/tokens', body)
}

export function revokeMyToken(tokenId: string): Promise<void> {
  return apiDelete(`/api/users/me/tokens/${encodeURIComponent(tokenId)}`)
}
