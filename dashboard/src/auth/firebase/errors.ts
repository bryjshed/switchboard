/**
 * Firebase's raw messages ("Firebase: Error (auth/invalid-credential).") are not for humans.
 * Map the codes a password form can actually produce; anything else falls through to a generic
 * line rather than leaking SDK internals into the UI.
 *
 * The code is read structurally rather than through `instanceof FirebaseError` on purpose: this
 * module is imported by the login page in every build, including OIDC-only ones that must not
 * pull in `firebase/app`.
 */
function codeOf(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const code = (err as { code?: unknown }).code
  return typeof code === 'string' ? code : null
}

export function firebaseSignInErrorMessage(err: unknown): string {
  switch (codeOf(err)) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password do not match an account.'
    case 'auth/invalid-email':
      return 'Enter a valid email address.'
    case 'auth/user-disabled':
      return 'That account has been disabled.'
    case 'auth/too-many-requests':
      return 'Too many attempts. Wait a moment and try again.'
    case 'auth/network-request-failed':
      return 'Could not reach the auth service. Is the emulator running on port 29099?'
    default:
      return 'Sign-in failed. Please try again.'
  }
}
