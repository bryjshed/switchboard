import { useEffect, useState } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { signInWithEmailAndPassword } from 'firebase/auth'
import { FirebaseError } from 'firebase/app'
import { auth, usingAuthEmulator } from '@/lib/firebase'
import { useAuth } from '@/hooks/useAuth'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { ToggleLeft } from 'lucide-react'

/**
 * Firebase's raw messages ("Firebase: Error (auth/invalid-credential).") are not for humans.
 * Map the codes a password form can actually produce; anything else falls through to a
 * generic line rather than leaking SDK internals into the UI.
 */
function signInErrorMessage(err: unknown): string {
  if (err instanceof FirebaseError) {
    switch (err.code) {
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
  return 'Sign-in failed. Please try again.'
}

export function LoginPage() {
  const navigate = useNavigate()
  const { firebaseUser, loading } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    document.title = 'Sign in · Switchboard'
  }, [])

  if (!loading && firebaseUser) return <Navigate to="/flags" replace />

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      await signInWithEmailAndPassword(auth, email.trim(), password)
      navigate('/flags', { replace: true })
    } catch (err) {
      setError(signInErrorMessage(err))
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <div className="mx-auto mb-2 flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ToggleLeft className="h-5 w-5" />
          </div>
          <CardTitle className="text-2xl">Switchboard</CardTitle>
          <CardDescription>Sign in to manage your feature flags</CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
    </div>
  )
}
