import { describe, expect, it } from 'vitest'
import { firebaseToAuthUser } from '@/auth/firebase/mapUser'
import { oidcToAuthUser } from '@/auth/oidc/mapUser'

/**
 * The whole point of `AuthUser` is that nothing above the seam can tell which IdP is live, so
 * both mappings are asserted against the same neutral shape.
 */
describe('firebaseToAuthUser', () => {
  it('maps uid to subject and keeps email and display name', () => {
    expect(
      firebaseToAuthUser({ uid: 'abc123', email: 'alice@switchboard.dev', displayName: 'Alice' }),
    ).toEqual({ subject: 'abc123', email: 'alice@switchboard.dev', displayName: 'Alice' })
  })

  it('normalises missing fields to null rather than undefined', () => {
    expect(firebaseToAuthUser({ uid: 'abc123', email: null, displayName: null })).toEqual({
      subject: 'abc123',
      email: null,
      displayName: null,
    })
  })

  it('maps a signed-out session to null', () => {
    expect(firebaseToAuthUser(null)).toBeNull()
  })
})

describe('oidcToAuthUser', () => {
  it('maps sub to subject and reads the standard claims', () => {
    expect(
      oidcToAuthUser({ profile: { sub: 'okta|9', email: 'alice@acme.com', name: 'Alice A' } }),
    ).toEqual({ subject: 'okta|9', email: 'alice@acme.com', displayName: 'Alice A' })
  })

  it('falls back to preferred_username, which is what Entra ID sends', () => {
    expect(
      oidcToAuthUser({ profile: { sub: 'x', preferred_username: 'alice@acme.onmicrosoft.com' } })
        ?.displayName,
    ).toBe('alice@acme.onmicrosoft.com')
  })

  it('falls back to nickname before giving up', () => {
    expect(oidcToAuthUser({ profile: { sub: 'x', nickname: 'ali' } })?.displayName).toBe('ali')
  })

  it('leaves display name null when the token carries no name claim at all', () => {
    expect(oidcToAuthUser({ profile: { sub: 'x' } })).toEqual({
      subject: 'x',
      email: null,
      displayName: null,
    })
  })

  it('ignores non-string and blank claims instead of rendering them', () => {
    expect(oidcToAuthUser({ profile: { sub: 'x', email: 42, name: '   ' } })).toEqual({
      subject: 'x',
      email: null,
      displayName: null,
    })
  })

  it('maps a missing user, or one with no sub, to null', () => {
    expect(oidcToAuthUser(null)).toBeNull()
    expect(oidcToAuthUser({ profile: { sub: '' } })).toBeNull()
  })
})
