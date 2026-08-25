import { describe, expect, it } from 'vitest'
import { AuthConfigError, readAuthConfig, type EnvSource } from '@/auth/config'

const ORIGIN = 'https://switchboard.example.com'

function read(source: EnvSource) {
  return readAuthConfig(source, ORIGIN)
}

describe('provider selection', () => {
  it('defaults to firebase so a clean checkout runs the local stack', () => {
    expect(read({}).kind).toBe('firebase')
  })

  it('treats a blank value as unset rather than an error', () => {
    expect(read({ VITE_AUTH_PROVIDER: '  ' }).kind).toBe('firebase')
  })

  it('selects firebase explicitly', () => {
    expect(read({ VITE_AUTH_PROVIDER: 'firebase' }).kind).toBe('firebase')
  })

  it('selects oidc', () => {
    const config = read({
      VITE_AUTH_PROVIDER: 'oidc',
      VITE_OIDC_AUTHORITY: 'https://acme.okta.com/oauth2/default',
      VITE_OIDC_CLIENT_ID: '0oa1b2c3',
    })
    expect(config.kind).toBe('oidc')
  })

  it('rejects an unknown provider by name, listing what is valid', () => {
    expect(() => read({ VITE_AUTH_PROVIDER: 'saml' })).toThrow(AuthConfigError)
    expect(() => read({ VITE_AUTH_PROVIDER: 'saml' })).toThrow(/VITE_AUTH_PROVIDER is "saml".*firebase, oidc/s)
  })
})

describe('firebase configuration', () => {
  it('defaults every value to the local emulator stack', () => {
    const config = read({})
    if (config.kind !== 'firebase') throw new Error('expected firebase')
    expect(config.firebase).toEqual({
      apiKey: 'demo-api-key',
      authDomain: 'demo-switchboard.firebaseapp.com',
      projectId: 'demo-switchboard',
      appId: 'demo-app-id',
    })
    expect(config.authEmulatorHost).toBe('http://localhost:29099')
    expect(config.providerName).toBe('Firebase')
  })

  it('takes overrides', () => {
    const config = read({
      VITE_FIREBASE_API_KEY: 'real-key',
      VITE_FIREBASE_PROJECT_ID: 'switchboard-prod',
      VITE_FIREBASE_AUTH_DOMAIN: 'auth.example.com',
      VITE_FIREBASE_APP_ID: '1:2:web:3',
    })
    if (config.kind !== 'firebase') throw new Error('expected firebase')
    expect(config.firebase.projectId).toBe('switchboard-prod')
    expect(config.firebase.authDomain).toBe('auth.example.com')
  })

  it('reads a blank emulator host as real Firebase', () => {
    const config = read({ VITE_FIREBASE_AUTH_EMULATOR_HOST: '' })
    if (config.kind !== 'firebase') throw new Error('expected firebase')
    expect(config.authEmulatorHost).toBeNull()
  })
})

describe('oidc configuration', () => {
  const base = {
    VITE_AUTH_PROVIDER: 'oidc',
    VITE_OIDC_AUTHORITY: 'https://acme.okta.com/oauth2/default',
    VITE_OIDC_CLIENT_ID: '0oa1b2c3',
  }

  it('derives redirect URIs from the origin and defaults the scope', () => {
    const config = read(base)
    if (config.kind !== 'oidc') throw new Error('expected oidc')
    expect(config.redirectUri).toBe(`${ORIGIN}/auth/callback`)
    expect(config.silentRedirectUri).toBe(`${ORIGIN}/auth/silent-callback`)
    expect(config.postLogoutRedirectUri).toBe(`${ORIGIN}/login`)
    expect(config.scope).toBe('openid profile email')
    expect(config.audience).toBeNull()
  })

  it('names the provider after the issuer host, for the sign-in button', () => {
    const config = read(base)
    expect(config.providerName).toBe('acme.okta.com')
  })

  it('lets the provider name be set outright', () => {
    expect(read({ ...base, VITE_OIDC_PROVIDER_NAME: 'Acme SSO' }).providerName).toBe('Acme SSO')
  })

  it('carries the audience through when set', () => {
    const config = read({ ...base, VITE_OIDC_AUDIENCE: 'https://api.switchboard.example.com' })
    if (config.kind !== 'oidc') throw new Error('expected oidc')
    expect(config.audience).toBe('https://api.switchboard.example.com')
  })

  it('takes explicit redirect URIs', () => {
    const config = read({ ...base, VITE_OIDC_REDIRECT_URI: 'https://other/cb' })
    if (config.kind !== 'oidc') throw new Error('expected oidc')
    expect(config.redirectUri).toBe('https://other/cb')
  })

  it('names the missing variable rather than failing at sign-in', () => {
    expect(() => read({ VITE_AUTH_PROVIDER: 'oidc' })).toThrow(/VITE_OIDC_AUTHORITY is required/)
    expect(() => read({ ...base, VITE_OIDC_CLIENT_ID: '' })).toThrow(
      /VITE_OIDC_CLIENT_ID is required/,
    )
  })

  it('rejects an authority that is not an absolute URL', () => {
    expect(() => read({ ...base, VITE_OIDC_AUTHORITY: 'acme.okta.com' })).toThrow(
      /not an absolute URL/,
    )
  })

  it('rejects a plaintext issuer that is not localhost', () => {
    expect(() => read({ ...base, VITE_OIDC_AUTHORITY: 'http://acme.okta.com' })).toThrow(
      /must be https/,
    )
  })

  it('allows a plaintext localhost issuer, for a local IdP', () => {
    expect(read({ ...base, VITE_OIDC_AUTHORITY: 'http://127.0.0.1:29199' }).kind).toBe('oidc')
  })
})
