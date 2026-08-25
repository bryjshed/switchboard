import { describe, expect, it } from 'vitest'
import { firebaseSignInErrorMessage } from '@/auth/firebase/errors'
import { oidcSignInErrorMessage } from '@/auth/oidc/errors'

describe('firebaseSignInErrorMessage', () => {
  it.each([
    ['auth/invalid-credential', 'That email and password do not match an account.'],
    ['auth/wrong-password', 'That email and password do not match an account.'],
    ['auth/user-not-found', 'That email and password do not match an account.'],
    ['auth/invalid-email', 'Enter a valid email address.'],
    ['auth/user-disabled', 'That account has been disabled.'],
    ['auth/too-many-requests', 'Too many attempts. Wait a moment and try again.'],
  ])('maps %s', (code, expected) => {
    expect(firebaseSignInErrorMessage({ code })).toBe(expected)
  })

  it('names the emulator port on a network failure, because that is the local cause', () => {
    expect(firebaseSignInErrorMessage({ code: 'auth/network-request-failed' })).toMatch(/29099/)
  })

  it('never leaks an unmapped SDK message', () => {
    expect(firebaseSignInErrorMessage(new Error('Firebase: Error (auth/internal-error).'))).toBe(
      'Sign-in failed. Please try again.',
    )
    expect(firebaseSignInErrorMessage(null)).toBe('Sign-in failed. Please try again.')
  })
})

describe('oidcSignInErrorMessage', () => {
  it('reads a cancelled sign-in as cancelled, not as a failure', () => {
    expect(oidcSignInErrorMessage({ error: 'access_denied' })).toMatch(/cancelled/)
  })

  it('explains invalid_grant as a spent or expired code', () => {
    expect(oidcSignInErrorMessage({ error: 'invalid_grant', error_description: 'code used' })).toMatch(
      /already been used or has expired/,
    )
  })

  it('points at the client registration for invalid_client', () => {
    expect(oidcSignInErrorMessage({ error: 'invalid_client' })).toMatch(/VITE_OIDC_CLIENT_ID/)
  })

  it('points at the scope variable for invalid_scope', () => {
    expect(oidcSignInErrorMessage({ error: 'invalid_scope' })).toMatch(/VITE_OIDC_SCOPE/)
  })

  it('asks the user to sign in again when the IdP wants interaction', () => {
    expect(oidcSignInErrorMessage({ error: 'login_required' })).toMatch(/sign in again/)
    expect(oidcSignInErrorMessage({ error: 'consent_required' })).toMatch(/sign in again/)
  })

  it('treats an IdP outage as retryable', () => {
    expect(oidcSignInErrorMessage({ error: 'temporarily_unavailable' })).toMatch(/Try again/)
  })

  it('recognises the library expired-state message a replayed callback produces', () => {
    expect(oidcSignInErrorMessage(new Error('No matching state found in storage'))).toMatch(
      /expired or was already used/,
    )
    expect(oidcSignInErrorMessage(new Error('State does not match'))).toMatch(
      /expired or was already used/,
    )
  })

  it('calls a nonce mismatch a security check rather than showing the raw message', () => {
    expect(oidcSignInErrorMessage(new Error('Invalid nonce in id_token'))).toMatch(/security check/)
  })

  it('separates an unreachable IdP from a rejected one', () => {
    expect(oidcSignInErrorMessage(new TypeError('Failed to fetch'))).toMatch(
      /VITE_OIDC_AUTHORITY/,
    )
    expect(oidcSignInErrorMessage(new Error('Failed to load openid-configuration'))).toMatch(
      /OpenID configuration/,
    )
  })

  it('maps a silent-renew timeout', () => {
    expect(oidcSignInErrorMessage(new Error('Silent renew timed out'))).toMatch(/did not respond/)
  })

  it('never dumps an unrecognised error string into the UI', () => {
    expect(oidcSignInErrorMessage(new Error('kaboom {"trace":"..."}'))).toBe(
      'Sign-in failed. Please try again.',
    )
    expect(oidcSignInErrorMessage(undefined)).toBe('Sign-in failed. Please try again.')
  })
})
