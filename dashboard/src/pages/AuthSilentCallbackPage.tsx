import { useEffect, useRef } from 'react'
import { requireAuthProvider } from '@/auth'

/**
 * The target of `silent_redirect_uri`. It only ever renders inside the hidden iframe
 * `oidc-client-ts` opens to renew a token, and its whole job is to hand the response back to
 * the parent window. Rendering nothing is correct: nobody sees this route.
 */
export function AuthSilentCallbackPage() {
  const started = useRef(false)

  useEffect(() => {
    if (started.current) return
    started.current = true
    void (async () => {
      try {
        const provider = await requireAuthProvider()
        await provider.handleSilentRenewCallback?.()
      } catch {
        // The parent's `addSilentRenewError` handler owns this outcome; there is no UI here.
      }
    })()
  }, [])

  return null
}
