import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FlagEnvStateChip } from '@/components/FlagEnvStateChip'
import { flagEnvStateLabel } from '@/lib/flagEnvState'
import { EnvDot } from '@/components/EnvChip'
import { TargetingTab } from './flags/TargetingTab'
import { MonitorTab } from './flags/MonitorTab'
import { AskAiDialog } from './ai/AskAiDialog'
import { HistoryTab } from './flags/HistoryTab'
import { FlagSettingsTab } from './flags/FlagSettingsTab'
import { getFlag } from '@/lib/flagsApi'
import { listSegments } from '@/lib/segmentsApi'
import { errorMessage } from '@/lib/apiClient'
import { compareEnvKeys } from '@/lib/envColors'
import { cn } from '@/lib/utils'
import { useWorkspace } from '@/hooks/useWorkspace'
import type { FlagDetail, FlagEnvConfig, Segment } from '@/types/api'

const TABS = ['targeting', 'monitor', 'history', 'settings'] as const
type TabValue = (typeof TABS)[number]

function isTab(value: string | null): value is TabValue {
  return value !== null && (TABS as readonly string[]).includes(value)
}

export function FlagDetailPage() {
  const { flagKey = '' } = useParams()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const { project, environment, selectEnvironment, loading: workspaceLoading } = useWorkspace()

  const [flag, setFlag] = useState<FlagDetail | null>(null)
  const [segments, setSegments] = useState<Segment[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [askOpen, setAskOpen] = useState(false)

  const tabParam = searchParams.get('tab')
  const tab: TabValue = isTab(tabParam) ? tabParam : 'targeting'

  const setTab = (next: string) => {
    setSearchParams(
      (prev) => {
        const params = new URLSearchParams(prev)
        params.set('tab', next)
        return params
      },
      { replace: true },
    )
  }

  const load = useCallback(async (): Promise<FlagDetail | null> => {
    if (!project) return null
    setError(null)
    try {
      const [detail, segmentList] = await Promise.all([
        getFlag(project.id, flagKey),
        listSegments(project.id),
      ])
      setFlag(detail)
      setSegments(segmentList)
      return detail
    } catch (err) {
      setError(errorMessage(err, 'Could not load this flag'))
      return null
    } finally {
      setLoading(false)
    }
  }, [project, flagKey])

  useEffect(() => {
    if (!project) {
      if (!workspaceLoading) setLoading(false)
      return
    }
    setLoading(true)
    void load()
  }, [project, workspaceLoading, load])

  // The rail and the header switcher select the same environment; the workspace owns it so
  // moving between flags keeps you in the environment you were working in.
  const envConfigs = useMemo(
    () => (flag ? [...flag.envConfigs].sort((a, b) => compareEnvKeys(a.envKey, b.envKey)) : []),
    [flag],
  )
  const activeConfig = useMemo(
    () => envConfigs.find((c) => c.envKey === environment?.key) ?? envConfigs[0] ?? null,
    [envConfigs, environment],
  )

  // The approval policy of the environment being edited — NOT of whatever the header picker
  // happens to show, which can differ when a flag has no config in the selected environment.
  const activeApprovals = useMemo(
    () => project?.environments.find((e) => e.key === activeConfig?.envKey)?.approvals,
    [project, activeConfig],
  )

  const applyConfig = useCallback((updated: FlagEnvConfig) => {
    setFlag((prev) =>
      prev
        ? {
            ...prev,
            envConfigs: prev.envConfigs.map((c) =>
              c.environmentId === updated.environmentId ? updated : c,
            ),
          }
        : prev,
    )
  }, [])

  const reloadActiveConfig = useCallback(async (): Promise<FlagEnvConfig | null> => {
    const fresh = await load()
    if (!fresh || !activeConfig) return null
    return fresh.envConfigs.find((c) => c.environmentId === activeConfig.environmentId) ?? null
  }, [load, activeConfig])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error || !flag || !project) {
    return (
      <div className="space-y-4">
        <Link to="/flags" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" /> Flags
        </Link>
        <p className="text-sm text-destructive" role="alert">
          {error ?? 'Flag not found'}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <Link
            to="/flags"
            data-testid="back-to-flags"
            className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="mr-1 h-4 w-4" /> Flags
          </Link>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h2 className="font-mono text-2xl font-bold tracking-tight">{flag.key}</h2>
            <Badge variant={flag.kind === 'STRING' ? 'secondary' : 'outline'}>
              {flag.kind === 'STRING' ? 'multivariate' : 'boolean'}
            </Badge>
            {flag.tags.map((t) => (
              <Badge key={t} variant="outline" className="text-[10px]">
                {t}
              </Badge>
            ))}
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            {flag.name}
            {flag.description ? ` — ${flag.description}` : ''}
          </p>
        </div>
        <Button variant="outline" data-testid="flag-ask-ai" onClick={() => setAskOpen(true)}>
          <Sparkles className="mr-1 h-4 w-4" /> Ask AI
        </Button>
      </div>

      <div className="grid gap-6 lg:grid-cols-[220px_1fr]">
        {/* Left rail: one entry per environment, the master side of the master/detail. */}
        <nav className="space-y-1" aria-label="Environments">
          <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
            Environment
          </p>
          {envConfigs.map((config) => {
            const isActive = config.environmentId === activeConfig?.environmentId
            return (
              <button
                key={config.environmentId}
                type="button"
                data-testid={`env-rail-${config.envKey}`}
                aria-current={isActive ? 'true' : undefined}
                onClick={() => selectEnvironment(config.envKey)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-left text-sm transition-colors',
                  isActive
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:bg-accent/60',
                )}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <EnvDot envKey={config.envKey} />
                  <span className="truncate font-mono">{config.envKey}</span>
                </span>
                <span
                  className={cn(
                    'shrink-0 text-xs',
                    config.killSwitchActive && 'font-semibold text-destructive',
                  )}
                >
                  {flagEnvStateLabel({
                    enabled: config.enabled,
                    killSwitchActive: config.killSwitchActive,
                  })}
                </span>
              </button>
            )
          })}
          <div className="pt-3">
            <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground/60">
              At a glance
            </p>
            <div className="flex flex-wrap gap-1 px-2">
              {envConfigs.map((config) => (
                <FlagEnvStateChip
                  key={config.environmentId}
                  summary={{
                    envKey: config.envKey,
                    enabled: config.enabled,
                    killSwitchActive: config.killSwitchActive,
                  }}
                />
              ))}
            </div>
          </div>
        </nav>

        <div className="min-w-0">
          <Tabs value={tab} onValueChange={setTab} className="w-full">
            <TabsList>
              <TabsTrigger value="targeting" data-testid="tab-targeting">
                Targeting
              </TabsTrigger>
              <TabsTrigger value="monitor" data-testid="tab-monitor">
                Monitor
              </TabsTrigger>
              <TabsTrigger value="history" data-testid="tab-history">
                History
              </TabsTrigger>
              <TabsTrigger value="settings" data-testid="tab-settings">
                Settings
              </TabsTrigger>
            </TabsList>

            <TabsContent value="targeting" className="mt-4">
              {activeConfig ? (
                <TargetingTab
                  key={activeConfig.environmentId}
                  projectId={project.id}
                  flag={flag}
                  config={activeConfig}
                  segments={segments}
                  approvals={activeApprovals}
                  onConfigChanged={applyConfig}
                  onReload={reloadActiveConfig}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  This flag has no configuration in any environment.
                </p>
              )}
            </TabsContent>

            <TabsContent value="monitor" className="mt-4">
              {activeConfig ? (
                <MonitorTab
                  key={activeConfig.environmentId}
                  projectId={project.id}
                  flag={flag}
                  config={activeConfig}
                  approvals={activeApprovals}
                  onRolledBack={applyConfig}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  This flag has no configuration in any environment.
                </p>
              )}
            </TabsContent>

            <TabsContent value="history" className="mt-4">
              {activeConfig && (
                <HistoryTab
                  key={activeConfig.environmentId}
                  projectId={project.id}
                  flagKey={flag.key}
                  envKey={activeConfig.envKey}
                  currentVersion={activeConfig.version}
                  approvals={activeApprovals}
                  onRolledBack={applyConfig}
                />
              )}
            </TabsContent>

            <TabsContent value="settings" className="mt-4">
              <FlagSettingsTab
                projectId={project.id}
                flag={flag}
                onUpdated={setFlag}
                onArchived={() => navigate('/flags')}
              />
            </TabsContent>
          </Tabs>
        </div>
      </div>

      <AskAiDialog
        projectId={project.id}
        open={askOpen}
        onOpenChange={setAskOpen}
        flagKey={flag.key}
        defaultEnvKey={activeConfig?.envKey}
        onApplied={() => void load()}
      />
    </div>
  )
}
