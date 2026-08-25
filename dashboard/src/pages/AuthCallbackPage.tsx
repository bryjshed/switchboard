import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { requireAuthProvider } from '@/auth'
import { oidcSignInErrorMessage } from '@/auth/oidc/errors'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * Where the OIDC redirect lands. It exchanges the authorization code (with the PKCE verifier
 * the provider stashed before leaving), then forwards to wherever the user was headed when the
 * gate bounced them — which is why `ProtectedRoute` carries the path into the sign-in state.
 *
 * The code is single-use, so the exchange must happen exactly once. StrictMode's double-invoked
 * effect would otherwise spend the code on the first run and show "invalid_grant" on the second.
 */
export function AuthCallbackPage() {
  const navigate = useNavigate()
  const started = useRef(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    document.title = 'Signing in · Switchboard'
    if (started.current) return
    started.current = true

    void (async () => {
      try {
        const provider = await requireAuthProvider()
        if (!provider.handleRedirectCallback) {
          throw new Error('This build is not configured for redirect sign-in.')
        }
        const { returnTo } = await provider.handleRedirectCallback()
        navigate(returnTo, { replace: true })
      } catch (err) {
        setError(oidcSignInErrorMessage(err))
      }
    })()
  }, [navigate])

  if (!error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div
          className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"
          role="status"
          aria-label="Completing sign-in"
        />
      </div>
    )
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle className="text-xl">Could not complete sign-in</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          <p className="text-sm text-destructive" role="alert" data-testid="callback-error">
            {error}
          </p>
          <Button
            className="w-full"
            onClick={() => navigate('/login', { replace: true })}
            data-testid="callback-retry"
          >
            Back to sign in
          </Button>
        </CardContent>
      </Card>
    </div>
  )
}
