import { useCallback, useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ArrowLeft, ExternalLink, Quote } from 'lucide-react'
import { Callout } from '@/components/ui/callout'
import { Skeleton } from '@/components/ui/skeleton'
import { EnvChip } from '@/components/EnvChip'
import { getProposal } from '@/lib/aiApi'
import { getFlag } from '@/lib/flagsApi'
import { getProject } from '@/lib/projectsApi'
import { errorMessage } from '@/lib/apiClient'
import { formatDateTime, formatRelative } from '@/lib/format'
import { useWorkspace } from '@/hooks/useWorkspace'
import { DiffPreview } from './DiffPreview'
import { ProposalActions } from './ProposalActions'
import { ProposalAuthor, ProposalKindBadge, ProposalStatusBadge } from './proposalBadges'
import type { AiProposal, FlagDetail } from '@/types/api'

export function ProposalDetailPage() {
  const { proposalId = '' } = useParams()
  const { selectEnvironment } = useWorkspace()

  const [proposal, setProposal] = useState<AiProposal | null>(null)
  const [flag, setFlag] = useState<FlagDetail | null>(null)
  const [envKey, setEnvKey] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [flagLoading, setFlagLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setError(null)
    try {
      const next = await getProposal(proposalId)
      setProposal(next)
      setFlagLoading(true)
      // Both lookups are best-effort: a proposal whose flag was archived, or a project the
      // workspace has not selected, must still render its diff rather than erroring out.
      const [detail, project] = await Promise.all([
        getFlag(next.projectId, next.diff.flagKey).catch(() => null),
        next.environmentId ? getProject(next.projectId).catch(() => null) : Promise.resolve(null),
      ])
      setFlag(detail)
      setEnvKey(project?.environments.find((e) => e.id === next.environmentId)?.key ?? null)
    } catch (err) {
      setError(errorMessage(err, 'Could not load this proposal'))
    } finally {
      setLoading(false)
      setFlagLoading(false)
    }
  }, [proposalId])

  useEffect(() => {
    setLoading(true)
    void load()
  }, [load])

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-8 w-64" />
        <Skeleton className="h-64 w-full" />
      </div>
    )
  }

  if (error || !proposal) {
    return (
      <div className="space-y-4">
        <Link
          to="/ai/proposals"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Proposals
        </Link>
        <p className="text-sm text-destructive" role="alert">
          {error ?? 'Proposal not found'}
        </p>
      </div>
    )
  }

  const flagLink = `/flags/${encodeURIComponent(proposal.diff.flagKey)}`

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <Link
          to="/ai/proposals"
          data-testid="back-to-proposals"
          className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="mr-1 h-4 w-4" /> Proposals
        </Link>
        <div className="mt-2 flex flex-wrap items-center gap-2">
          <ProposalKindBadge kind={proposal.kind} />
          <ProposalStatusBadge
                    status={proposal.status}
                    pendingChangeRequestId={proposal.pendingChangeRequestId}
                  />
          <span className="font-mono text-xl font-bold tracking-tight">
            {proposal.diff.flagKey}
          </span>
          {envKey && <EnvChip envKey={envKey} />}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          <ProposalAuthor createdBy={proposal.createdBy} />
          <span className="text-xs text-muted-foreground" title={formatDateTime(proposal.createdAt)}>
            {formatRelative(proposal.createdAt)}
          </span>
        </div>
      </div>

      {proposal.sourcePrompt && (
        <blockquote
          className="flex gap-2 rounded-md border-l-2 border-border bg-muted/40 py-2 pl-3 pr-4 text-sm"
          data-testid="proposal-prompt"
        >
          <Quote className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          <span>{proposal.sourcePrompt}</span>
        </blockquote>
      )}

      {proposal.rationale && (
        <Callout variant="info" data-testid="proposal-rationale">
          {proposal.rationale}
        </Callout>
      )}

      <DiffPreview diff={proposal.diff} flag={flag} flagLoading={flagLoading} />

      {proposal.status === 'DRAFT' ? (
        <ProposalActions proposal={proposal} onChanged={setProposal} onRefresh={() => void load()} />
      ) : (
        <div className="rounded-md border p-4" data-testid="proposal-outcome">
          <p className="text-sm">
            {proposal.status === 'APPLIED' ? (
              <>
                Applied{proposal.appliedBy ? ` by ${proposal.appliedBy}` : ''}
                {proposal.appliedVersion != null ? ` as version ${proposal.appliedVersion}` : ''}.
              </>
            ) : proposal.status === 'REJECTED' ? (
              <>Rejected{proposal.appliedBy ? ` by ${proposal.appliedBy}` : ''}. The flag was left unchanged.</>
            ) : (
              <>This proposal expired before anyone acted on it. Nothing was changed.</>
            )}
          </p>
          {proposal.status === 'APPLIED' && (
            <Link
              to={`${flagLink}?tab=history`}
              data-testid="proposal-applied-version"
              onClick={() => envKey && selectEnvironment(envKey)}
              className="mt-2 inline-flex items-center gap-1 text-sm underline underline-offset-2 hover:text-foreground"
            >
              {proposal.appliedVersion != null
                ? `Open version ${proposal.appliedVersion} in the flag's history`
                : "Open the flag's history"}
              <ExternalLink className="h-3 w-3" aria-hidden />
            </Link>
          )}
        </div>
      )}

      <Link
        to={flagLink}
        data-testid="proposal-open-flag"
        onClick={() => envKey && selectEnvironment(envKey)}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground underline underline-offset-2 hover:text-foreground"
      >
        Open {proposal.diff.flagKey}
        <ExternalLink className="h-3 w-3" aria-hidden />
      </Link>
    </div>
  )
}
