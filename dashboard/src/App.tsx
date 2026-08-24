import { Navigate, Route, Routes } from 'react-router-dom'
import { AppLayout } from '@/components/layout/AppLayout'
import { ProtectedRoute } from '@/components/ProtectedRoute'
import { LoginPage } from '@/pages/LoginPage'
import { FlagsPage } from '@/pages/FlagsPage'
import { FlagDetailPage } from '@/pages/FlagDetailPage'
import { SegmentsPage } from '@/pages/SegmentsPage'
import { SettingsPage } from '@/pages/SettingsPage'
import { MonitorPage } from '@/pages/MonitorPage'
import { ActivityPage } from '@/pages/ActivityPage'
import { ProposalsPage } from '@/pages/ai/ProposalsPage'
import { ProposalDetailPage } from '@/pages/ai/ProposalDetailPage'
import { ChangeRequestsPage } from '@/pages/changeRequests/ChangeRequestsPage'
import { ChangeRequestDetailPage } from '@/pages/changeRequests/ChangeRequestDetailPage'

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <AppLayout />
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
