import { useEffect, useState } from 'react'
import { Navigate, useLocation, useNavigate } from 'react-router-dom'
import { firebaseSignInErrorMessage } from '@/auth/firebase/errors'
import { oidcSignInErrorMessage } from '@/auth/oidc/errors'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { LogIn, ToggleLeft } from 'lucide-react'

/** Both mappers are pure string functions, so neither build pulls in the other's SDK. */
function signInErrorMessage(kind: 'firebase' | 'oidc', err: unknown): string {
  return kind === 'oidc' ? oidcSignInErrorMessage(err) : firebaseSignInErrorMessage(err)
}

function Shell({ children, subtitle }: { children: React.ReactNode; subtitle: string }) {
  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ToggleLeft className="h-5 w-5" />
          </div>
          <CardTitle className="text-2xl">Switchboard</CardTitle>
          <CardDescription>{subtitle}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </div>
  )
}

export function LoginPage() {
  const navigate = useNavigate()
  const location = useLocation()
  const { user, loading, authError, providerKind, providerName, usingAuthEmulator, signIn } =
    useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  const returnTo = (location.state as { from?: string } | null)?.from ?? '/flags'

  useEffect(() => {
    document.title = 'Sign in · Switchboard'
  }, [])

  if (authError) {
    return (
      <Shell subtitle="Authentication is not configured">
        <p className="text-sm text-destructive" role="alert" data-testid="login-config-error">
          {authError}
        </p>
      </Shell>
    )
  }

  if (!loading && user) return <Navigate to={returnTo} replace />

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await signIn({ email, password })
      navigate(returnTo, { replace: true })
    } catch (err) {
      setError(signInErrorMessage('firebase', err))
    } finally {
      setSubmitting(false)
    }
  }

  // OIDC: there is no form. The IdP owns the credential, and this button hands the browser to
  // it; the code exchange finishes on /auth/callback.
  const handleRedirect = async () => {
    setSubmitting(true)
    setError(null)
    try {
      await signIn({ returnTo })
    } catch (err) {
      setError(signInErrorMessage('oidc', err))
      setSubmitting(false)
    }
  }

  if (providerKind === 'oidc') {
    return (
      <Shell subtitle="Sign in to manage your feature flags">
        <div className="flex flex-col gap-4">
          <Button
            className="w-full"
            disabled={submitting}
            onClick={() => void handleRedirect()}
            data-testid="login-oidc"
          >
            <LogIn className="mr-2 h-4 w-4" />
            {submitting ? 'Redirecting…' : `Sign in with ${providerName}`}
          </Button>
          {error && (
            <p className="text-sm text-destructive" role="alert" data-testid="login-error">
              {error}
            </p>
          )}
          <p className="text-center text-xs text-muted-foreground">
            You will be sent to {providerName} and returned here once you have signed in.
          </p>
        </div>
      </Shell>
    )
  }

  return (
    <Shell subtitle="Sign in to manage your feature flags">
      <form className="flex flex-col gap-4" onSubmit={(e) => void handleSubmit(e)}>
        <div className="space-y-1.5">
          <Label htmlFor="login-email">Email</Label>
          <Input
            id="login-email"
            data-testid="login-email"
            type="email"
            required
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@example.com"
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="login-password">Password</Label>
          <Input
            id="login-password"
            data-testid="login-password"
            type="password"
            required
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </div>
        {error && (
          <p className="text-sm text-destructive" role="alert" data-testid="login-error">
            {error}
          </p>
        )}
        <Button type="submit" className="w-full" disabled={submitting} data-testid="login-submit">
          {submitting ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
      {usingAuthEmulator && (
        <p className="mt-4 text-center text-xs text-muted-foreground">
          Local auth emulator. Seeded logins: alice@switchboard.dev (owner),
          bob@switchboard.dev (member), carol@beta.dev (other org) — password
          <code className="ml-1 font-mono">password123</code>
        </p>
      )}
    </Shell>
  )
}
