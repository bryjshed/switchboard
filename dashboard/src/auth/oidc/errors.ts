/**
 * Human sentences for OIDC failures, the counterpart to `firebaseSignInErrorMessage`.
 *
 * Two error vocabularies arrive here. The IdP's, as RFC 6749 `error` codes carried on
 * `oidc-client-ts`'s `ErrorResponse` (`invalid_grant`, `access_denied`, …), and the library's
 * own, as plain `Error` messages for the client-side checks it does before it will trust a
 * callback ("No matching state found in storage" when the state has expired or the link was
 * replayed). Both are matched structurally so this module stays free of `oidc-client-ts`, which
 * keeps it importable from a Firebase-only build.
 */
function errorCode(err: unknown): string | null {
  if (typeof err !== 'object' || err === null) return null
  const code = (err as { error?: unknown }).error
  return typeof code === 'string' ? code : null
}

function messageOf(err: unknown): string {
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return typeof err === 'string' ? err : ''
}

export function oidcSignInErrorMessage(err: unknown): string {
  switch (errorCode(err)) {
    case 'access_denied':
      return 'Sign-in was cancelled, or your identity provider refused the request.'
    case 'invalid_grant':
      return 'That sign-in link has already been used or has expired. Try signing in again.'
    case 'login_required':
    case 'interaction_required':
    case 'consent_required':
      return 'Your identity provider needs you to sign in again.'
    case 'invalid_client':
    case 'unauthorized_client':
      return 'This dashboard is not registered correctly with your identity provider. Check VITE_OIDC_CLIENT_ID and the allowed redirect URIs.'
    case 'invalid_scope':
      return 'Your identity provider rejected the requested scopes. Check VITE_OIDC_SCOPE.'
    case 'server_error':
    case 'temporarily_unavailable':
      return 'Your identity provider had a problem completing the sign-in. Try again in a moment.'
  }

  const message = messageOf(err)
  if (/no matching state|no state in response|state does not match/i.test(message)) {
    return 'That sign-in link has expired or was already used. Start again from the sign-in page.'
  }
  if (/nonce/i.test(message)) {
    return 'The response from your identity provider failed a security check. Start again from the sign-in page.'
  }
  if (/timed? ?out|ErrorTimeout/i.test(message)) {
    return 'Your identity provider did not respond in time. Try again.'
  }
  if (/failed to fetch|networkerror|load failed/i.test(message)) {
    return 'Could not reach your identity provider. Check the network and VITE_OIDC_AUTHORITY.'
  }
  if (/metadata|discovery|openid-configuration/i.test(message)) {
    return 'Could not read your identity provider\'s OpenID configuration. Check VITE_OIDC_AUTHORITY.'
  }
  return 'Sign-in failed. Please try again.'
}
