import { Navigate, useLocation } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { WorkspaceProvider } from '@/context/WorkspaceProvider'
import { PermissionsProvider } from '@/context/PermissionsProvider'
import { Button } from '@/components/ui/button'

function FullScreen({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      {children}
    </div>
  )
}

/**
 * Gates the app shell on a signed-in session AND a resolved Switchboard profile.
 * The workspace provider mounts inside the gate so it never fires API calls without a token,
 * and the permissions provider inside that, because the scope it asks about is whatever the
 * workspace has selected.
 */
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, profile, loading, profileError, authError, reloadProfile, signOut } = useAuth()
  const location = useLocation()

  // A configuration fault is not a sign-in problem, and bouncing to /login would hide it behind
  // a form that cannot work either.
  if (authError) {
    return (
      <FullScreen>
        <h2 className="text-2xl font-semibold">Authentication is not configured</h2>
        <p className="max-w-md text-sm text-muted-foreground" data-testid="auth-config-error">
          {authError}
        </p>
      </FullScreen>
    )
  }

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div
          className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary"
          role="status"
          aria-label="Loading"
        />
      </div>
    )
  }

  if (!user) {
    // Carry the intended destination so an OIDC redirect round-trip can land back on it.
    return <Navigate to="/login" state={{ from: location.pathname + location.search }} replace />
  }

  if (!profile) {
    return (
      <FullScreen>
        <h2 className="text-2xl font-semibold">Could not load your account</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {profileError ?? 'The Switchboard API did not return a profile for this sign-in.'}
        </p>
        <p className="text-sm text-muted-foreground">Signed in as {user.email ?? user.subject}</p>
        <div className="flex gap-2">
          <Button onClick={() => void reloadProfile()} data-testid="retry-profile">
            Try again
          </Button>
          <Button variant="outline" onClick={() => void signOut()} data-testid="signout-fallback">
            Sign out
          </Button>
        </div>
      </FullScreen>
    )
  }

  return (
    <WorkspaceProvider>
      <PermissionsProvider>{children}</PermissionsProvider>
    </WorkspaceProvider>
  )
}
