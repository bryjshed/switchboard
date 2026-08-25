import { describe, expect, it } from 'vitest'
import { WebStorageStateStore } from 'oidc-client-ts'
import { oidcSettings, tokenFor } from '@/auth/oidc/settings'
import type { OidcAuthConfig } from '@/auth/config'

const CONFIG: OidcAuthConfig = {
  kind: 'oidc',
  providerName: 'acme.okta.com',
  authority: 'https://acme.okta.com/oauth2/default',
  clientId: '0oa1b2c3',
  scope: 'openid profile email',
  audience: null,
  redirectUri: 'https://app.example.com/auth/callback',
  silentRedirectUri: 'https://app.example.com/auth/silent-callback',
  postLogoutRedirectUri: 'https://app.example.com/login',
}

function memoryStorage(): Storage {
  const map = new Map<string, string>()
  return {
    get length() {
      return map.size
    },
    clear: () => map.clear(),
    getItem: (k) => map.get(k) ?? null,
    key: (i) => [...map.keys()][i] ?? null,
    removeItem: (k) => void map.delete(k),
    setItem: (k, v) => void map.set(k, v),
  }
}

describe('oidcSettings', () => {
  it('uses the authorization code flow, which is what makes PKCE apply', () => {
    expect(oidcSettings(CONFIG, memoryStorage()).response_type).toBe('code')
  })

  it('carries the authority, client id and every redirect through', () => {
    const settings = oidcSettings(CONFIG, memoryStorage())
    expect(settings.authority).toBe(CONFIG.authority)
    expect(settings.client_id).toBe(CONFIG.clientId)
    expect(settings.redirect_uri).toBe(CONFIG.redirectUri)
    expect(settings.silent_redirect_uri).toBe(CONFIG.silentRedirectUri)
    expect(settings.post_logout_redirect_uri).toBe(CONFIG.postLogoutRedirectUri)
    expect(settings.scope).toBe(CONFIG.scope)
  })

  it('keeps the token fresh in the background', () => {
    expect(oidcSettings(CONFIG, memoryStorage()).automaticSilentRenew).toBe(true)
  })

  it('sends the audience as an authorization parameter only when one is configured', () => {
    expect(oidcSettings(CONFIG, memoryStorage()).extraQueryParams).toBeUndefined()
    expect(
      oidcSettings({ ...CONFIG, audience: 'sb-api' }, memoryStorage()).extraQueryParams,
    ).toEqual({ audience: 'sb-api' })
  })

  it('namespaces its storage so it cannot collide with anything else on the origin', () => {
    const store = memoryStorage()
    const settings = oidcSettings(CONFIG, store)
    expect(settings.userStore).toBeInstanceOf(WebStorageStateStore)
    expect(settings.stateStore).toBeInstanceOf(WebStorageStateStore)
  })
})

describe('tokenFor', () => {
  const user = { access_token: 'access-jwt', id_token: 'id-jwt' }

  it('sends the access token when the deployment declares an API audience', () => {
    expect(tokenFor(user, { ...CONFIG, audience: 'sb-api' })).toBe('access-jwt')
  })

  it('sends the id token when there is no audience to scope an access token to', () => {
    expect(tokenFor(user, CONFIG)).toBe('id-jwt')
  })

  it('returns null rather than "undefined" when the chosen token is absent', () => {
    expect(tokenFor({ access_token: 'a', id_token: undefined }, CONFIG)).toBeNull()
  })
})
