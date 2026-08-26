import { useSearchParams } from 'react-router-dom'
import { PageHeading } from '@/components/layout/PageHeading'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Skeleton } from '@/components/ui/skeleton'
import { OrganizationTab } from './settings/OrganizationTab'
import { SdkKeysTab } from './settings/SdkKeysTab'
import { AiTab } from './settings/AiTab'
import { TokensTab } from './settings/TokensTab'
import { AccessTab } from './settings/AccessTab'
import { ApprovalsTab } from './settings/ApprovalsTab'
import { WebhooksTab } from './settings/WebhooksTab'
import { EnvironmentsTab } from './settings/EnvironmentsTab'
import { useWorkspace } from '@/hooks/useWorkspace'
import { usePermissions } from '@/hooks/usePermissions'

const TABS = [
  'organization',
  'access',
  'environments',
  'approvals',
  'sdk-keys',
  'tokens',
  'webhooks',
  'ai',
] as const
type TabValue = (typeof TABS)[number]

function isTab(value: string | null): value is TabValue {
  return value !== null && (TABS as readonly string[]).includes(value)
}

export function SettingsPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const { org, project, environments, loading, refresh } = useWorkspace()
  const { has } = usePermissions()

  // Both admin tabs stay VISIBLE to everyone and refuse inside instead of vanishing: a tab
  // that disappears reads as a missing feature, while one that explains itself teaches the
  // permission model. Neither is a security boundary — the backend refuses the writes.
  const canManageMembers = has('MANAGE_MEMBERS')
  const canManageEnvironments = has('MANAGE_ENVIRONMENTS')

  const tabParam = searchParams.get('tab')
  const tab: TabValue = isTab(tabParam) ? tabParam : 'organization'

  const setTab = (next: string) =>
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('tab', next)
        return params
      },
      { replace: true },
    )

  return (
    <div className="space-y-6">
      <PageHeading
        title="Settings"
        description="Membership and roles, environments and their approval policy, SDK keys, webhooks, and the AI layer's switches."
      />

      <Tabs value={tab} onValueChange={setTab} className="w-full">
        <TabsList>
          <TabsTrigger value="organization" data-testid="tab-organization">
            Organization
          </TabsTrigger>
          <TabsTrigger value="access" data-testid="tab-access">
            Roles &amp; access
          </TabsTrigger>
          <TabsTrigger value="environments" data-testid="tab-environments">
            Environments
          </TabsTrigger>
          <TabsTrigger value="approvals" data-testid="tab-approvals">
            Approvals
          </TabsTrigger>
          <TabsTrigger value="sdk-keys" data-testid="tab-sdk-keys">
            SDK keys
          </TabsTrigger>
          <TabsTrigger value="tokens" data-testid="tab-tokens">
            Tokens
          </TabsTrigger>
          <TabsTrigger value="webhooks" data-testid="tab-webhooks">
            Webhooks
          </TabsTrigger>
          <TabsTrigger value="ai" data-testid="tab-ai">
            AI
          </TabsTrigger>
        </TabsList>

        <TabsContent value="organization" className="mt-4">
          {loading && !org ? (
            <Skeleton className="h-64 w-full" />
          ) : org ? (
            <OrganizationTab org={org} />
          ) : (
            <p className="text-sm text-muted-foreground">No organization selected.</p>
          )}
        </TabsContent>

        <TabsContent value="access" className="mt-4">
          {loading && !org ? (
            <Skeleton className="h-96 w-full" />
          ) : !org ? (
            <p className="text-sm text-muted-foreground">No organization selected.</p>
          ) : canManageMembers ? (
            <AccessTab org={org} />
          ) : (
            <p className="text-sm text-muted-foreground" data-testid="access-denied">
              Granting and revoking roles needs the permission to manage people and roles. Ask
              an owner or admin — they can see who holds what on this tab.
            </p>
          )}
        </TabsContent>

        <TabsContent value="webhooks" className="mt-4">
          {loading && !org ? (
            <Skeleton className="h-64 w-full" />
          ) : org ? (
            // Guarded by MANAGE_SETTINGS on the server; the tab stays visible and the API
            // refuses, matching how the other admin tabs behave.
            <WebhooksTab orgId={org.id} />
          ) : (
            <p className="text-sm text-muted-foreground">No organization selected.</p>
          )}
        </TabsContent>

        <TabsContent value="environments" className="mt-4">
          {loading && environments.length === 0 ? (
            <Skeleton className="h-64 w-full" />
          ) : project ? (
            <EnvironmentsTab
              projectId={project.id}
              projectName={project.name}
              environments={environments}
              canManage={canManageEnvironments}
              onCreated={refresh}
            />
          ) : (
            <p className="text-sm text-muted-foreground">No project selected.</p>
          )}
        </TabsContent>

        <TabsContent value="approvals" className="mt-4">
          <ApprovalsTab canManage={canManageEnvironments} />
        </TabsContent>

        <TabsContent value="sdk-keys" className="mt-4">
          <SdkKeysTab environments={environments} />
        </TabsContent>

        {/* Tokens are personal, not org-scoped: no org needed, and no gate beyond being signed in. */}
        <TabsContent value="tokens" className="mt-4">
          <TokensTab />
        </TabsContent>

        <TabsContent value="ai" className="mt-4">
          {loading && !org ? (
            <Skeleton className="h-64 w-full max-w-2xl" />
          ) : org ? (
            <AiTab org={org} />
          ) : (
            <p className="text-sm text-muted-foreground">No organization selected.</p>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
