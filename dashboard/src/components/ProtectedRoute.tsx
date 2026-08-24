import { Navigate } from 'react-router-dom'
import { useAuth } from '@/hooks/useAuth'
import { WorkspaceProvider } from '@/context/WorkspaceProvider'
import { PermissionsProvider } from '@/context/PermissionsProvider'
import { Button } from '@/components/ui/button'

/**
 * Gates the app shell on a signed-in Firebase session AND a resolved Switchboard profile.
 * The workspace provider mounts inside the gate so it never fires API calls without a token,
 * and the permissions provider inside that, because the scope it asks about is whatever the
 * workspace has selected.
 */
export function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { firebaseUser, profile, loading, profileError, reloadProfile, signOut } = useAuth()

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

  if (!firebaseUser) {
    return <Navigate to="/login" replace />
  }

  if (!profile) {
    return (
      <div className="min-h-screen flex flex-col items-center justify-center gap-4 bg-background px-6 text-center">
        <h2 className="text-2xl font-semibold">Could not load your account</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {profileError ?? 'The Switchboard API did not return a profile for this sign-in.'}
        </p>
        <p className="text-sm text-muted-foreground">Signed in as {firebaseUser.email}</p>
        <div className="flex gap-2">
          <Button onClick={() => void reloadProfile()} data-testid="retry-profile">
            Try again
          </Button>
          <Button variant="outline" onClick={() => void signOut()} data-testid="signout-fallback">
            Sign out
          </Button>
        </div>
      </div>
    )
  }

  return (
    <WorkspaceProvider>
      <PermissionsProvider>{children}</PermissionsProvider>
    </WorkspaceProvider>
  )
}
