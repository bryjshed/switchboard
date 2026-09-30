import type { AuthUser } from '../types'

/** The claims this dashboard reads off an OIDC profile. */
export interface OidcProfileLike {
  sub: string
  email?: unknown
  name?: unknown
  preferred_username?: unknown
  nickname?: unknown
  email_verified?: unknown
}

export interface OidcUserLike {
  profile: OidcProfileLike
}

/**
 * `email_verified` is a boolean in the spec, but Cognito sends the STRING "true"/"false".
 * Anything else is "the IdP did not say", which is not the same as unverified.
 */
function verifiedClaim(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

function claim(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/**
 * OIDC user → provider-neutral `AuthUser`.
 *
 * `name` is optional in the spec and several IdPs never send it: Entra ID leans on
 * `preferred_username`, Cognito on `nickname`. Falling through them beats rendering "null" in
 * the account menu. `sub` is the only claim guaranteed present, so it is the last resort for a
 * display name and the sole source of `subject`.
 */
export function oidcToAuthUser(user: OidcUserLike | null): AuthUser | null {
  if (!user?.profile?.sub) return null
  const { profile } = user
  return {
    subject: profile.sub,
    email: claim(profile.email),
    displayName:
      claim(profile.name) ?? claim(profile.preferred_username) ?? claim(profile.nickname) ?? null,
    emailVerified: verifiedClaim(profile.email_verified),
  }
}
