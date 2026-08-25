import { Suspense, lazy } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { Skeleton } from '@/components/ui/skeleton'
import { LoginPage } from '@/pages/LoginPage'
import { AuthCallbackPage } from '@/pages/AuthCallbackPage'
import { AuthSilentCallbackPage } from '@/pages/AuthSilentCallbackPage'

/*
 * Routes are lazy; the login and auth-callback pages are not.
 *
 * Everything below the ProtectedRoute is only reachable after a successful sign-in, so splitting it
 * out costs nothing on first paint and keeps the initial bundle to the shell plus auth. The three
 * eager imports above are the opposite case: they ARE the first paint for a signed-out visitor, and
 * a chunk request in front of the login form would be latency for no benefit.
 */
const FlagsPage = lazy(() => import('@/pages/FlagsPage').then((m) => ({ default: m.FlagsPage })))
const FlagDetailPage = lazy(() =>
  import('@/pages/FlagDetailPage').then((m) => ({ default: m.FlagDetailPage })),
)
const SegmentsPage = lazy(() =>
  import('@/pages/SegmentsPage').then((m) => ({ default: m.SegmentsPage })),
)
const SettingsPage = lazy(() =>
  import('@/pages/SettingsPage').then((m) => ({ default: m.SettingsPage })),
)
const MonitorPage = lazy(() =>
  import('@/pages/MonitorPage').then((m) => ({ default: m.MonitorPage })),
)
const ActivityPage = lazy(() =>
  import('@/pages/ActivityPage').then((m) => ({ default: m.ActivityPage })),
)
const ProposalsPage = lazy(() =>
  import('@/pages/ai/ProposalsPage').then((m) => ({ default: m.ProposalsPage })),
)
const ProposalDetailPage = lazy(() =>
  import('@/pages/ai/ProposalDetailPage').then((m) => ({ default: m.ProposalDetailPage })),
)
const ChangeRequestsPage = lazy(() =>
  import('@/pages/changeRequests/ChangeRequestsPage').then((m) => ({
    default: m.ChangeRequestsPage,
  })),
)
const ChangeRequestDetailPage = lazy(() =>
  import('@/pages/changeRequests/ChangeRequestDetailPage').then((m) => ({
    default: m.ChangeRequestDetailPage,
  })),
)

/** A page-shaped placeholder, so a route change does not collapse the layout while a chunk loads. */
function RouteFallback() {
  return <Skeleton className="h-64 w-full" />
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      {/* OIDC redirect targets. Outside the gate: nobody is signed in yet when they land here,
          and the silent one renders inside a hidden iframe that must not mount the app shell. */}
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      <Route path="/auth/silent-callback" element={<AuthSilentCallbackPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            {/* One boundary around the whole authenticated area rather than one per route: the
                fallback is identical everywhere and nesting them would only add flicker. */}
            <Suspense fallback={<RouteFallback />}>
              <AppLayout />
            </Suspense>
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/flags" replace />} />
        <Route path="flags" element={<FlagsPage />} />
        {/* The rollout monitor is a tab on the flag detail (`?tab=monitor`), not a route of
            its own: it needs the same flag + environment selection the other tabs already
            own, and a separate route would fork that state. */}
        <Route path="flags/:flagKey" element={<FlagDetailPage />} />
        <Route path="segments" element={<SegmentsPage />} />
        <Route path="monitor" element={<MonitorPage />} />
        <Route path="activity" element={<ActivityPage />} />
        <Route path="change-requests" element={<ChangeRequestsPage />} />
        <Route path="change-requests/:changeRequestId" element={<ChangeRequestDetailPage />} />
        <Route path="ai/proposals" element={<ProposalsPage />} />
        <Route path="ai/proposals/:proposalId" element={<ProposalDetailPage />} />
        <Route path="settings" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/flags" replace />} />
      </Route>
    </Routes>
  )
}
