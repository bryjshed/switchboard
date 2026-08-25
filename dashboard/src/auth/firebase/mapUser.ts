import type { AuthUser } from '../types'

/** The shape of a Firebase `User` this dashboard actually depends on. */
export interface FirebaseUserLike {
  uid: string
  email: string | null
  displayName: string | null
}

/**
 * Firebase `User` → provider-neutral `AuthUser`. Kept in its own dependency-free module so the
 * mapping can be tested (and imported) without loading the Firebase SDK.
 */
export function firebaseToAuthUser(user: FirebaseUserLike | null): AuthUser | null {
  if (!user) return null
  return {
    subject: user.uid,
    email: user.email ?? null,
    displayName: user.displayName ?? null,
  }
}
