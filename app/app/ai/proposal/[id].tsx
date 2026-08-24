import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';

import { DiffPreview } from '@features/ai/components/DiffPreview';
import { isConflict } from '@features/ai/lib/aiErrors';
import { proposalStatusLabel, proposalStatusTone } from '@features/ai/lib/diffSummary';
import {
  useApplyProposalMutation,
  useRejectProposalMutation,
} from '@features/ai/mutations/aiMutations';
import { proposalDetailOptions } from '@features/ai/queries/aiQueries';
import { flagDetailOptions } from '@features/flags/queries/flagQueries';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { dateTimeLabel } from '@shared/lib/time';
import { spacing, useTheme } from '@shared/theme';
import {
  AsyncStateView,
  BackButton,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  MonoText,
  PageHeader,
  ScreenView,
  Skeleton,
  TextInput,
} from '@shared/ui';

function ProposalSkeleton() {
  return (
    <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
      {[0, 1].map((i) => (
        <Card key={i} testID={`proposal-skeleton-${i}`} style={{ gap: spacing.md }}>
          <Skeleton width="35%" height={20} radius={999} />
          <Skeleton height={40} />
          <Skeleton width="70%" height={14} />
        </Card>
      ))}
    </View>
  );
}

/**
 * A proposal, end to end: what it changes, why, who asked, and what happened.
 * Apply and Reject exist only while it is a DRAFT — an applied proposal is a
 * record, and the version it produced is named so it can be traced in history.
 */
export default function ProposalDetailScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { userId, orgId, projectId } = useActiveContext();

  const [confirm, setConfirm] = useState<'apply' | 'reject' | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const proposalQuery = useQuery(proposalDetailOptions(userId, id));
  const proposal = proposalQuery.data;
  const flagQuery = useQuery(flagDetailOptions(userId, projectId, proposal?.diff.flagKey));

  const scope = { userId, orgId, projectId };
  const apply = useApplyProposalMutation(scope);
  const reject = useRejectProposalMutation(scope);

  const isDraft = proposal?.status === 'DRAFT';
  const pending = apply.isPending || reject.isPending;

  const run = async (action: 'apply' | 'reject') => {
    if (!proposal) return;
    setConfirm(null);
    setMessage(null);
    const vars = { proposalId: proposal.id, reason: reason.trim() || undefined };
    try {
      if (action === 'apply') {
        const applied = await apply.mutateAsync(vars);
        setReason('');
        router.replace(`/flag/${encodeURIComponent(applied.diff.flagKey)}`);
      } else {
        await reject.mutateAsync(vars);
        setReason('');
      }
    } catch (e) {
      if (isConflict(e)) {
        setMessage(
          action === 'apply'
            ? 'This proposal was already applied.'
            : 'This proposal is no longer a draft.',
        );
        void proposalQuery.refetch();
        return;
      }
      setMessage(e instanceof Error ? e.message : `${action} failed`);
    }
  };

  return (
    <ScreenView bottomInset testID="proposal-detail-screen">
      <PageHeader
        title="Proposal"
        subtitle={proposal ? proposal.diff.flagKey : undefined}
        left={<BackButton fallbackHref="/monitor" />}
        testID="proposal-detail-header"
      />
      <AsyncStateView
        testID="proposal-detail-async"
        loading={proposalQuery.isLoading && !proposalQuery.data}
        error={proposalQuery.error}
        skeleton={<ProposalSkeleton />}
        onRetry={() => proposalQuery.refetch()}
      >
        <ScrollView
          testID="proposal-detail-scroll"
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.xxl,
            gap: spacing.lg,
          }}
          refreshControl={
            <RefreshControl
              refreshing={proposalQuery.isRefetching && !pending}
              onRefresh={() => void proposalQuery.refetch()}
              tintColor={tokens.text.tertiary}
            />
          }
        >
          {proposal ? (
            <>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Badge
                  testID="proposal-status"
                  label={proposalStatusLabel(proposal.status)}
                  tone={proposalStatusTone(proposal.status)}
                />
                <Text style={[typography.caption, { color: tokens.text.tertiary, flex: 1 }]}>
                  {dateTimeLabel(proposal.createdAt)}
                </Text>
              </View>

              <DiffPreview
                diff={proposal.diff}
                flag={flagQuery.data}
                flagLoading={flagQuery.isLoading}
              />

              {proposal.rationale ? (
                <Card testID="proposal-rationale" style={{ gap: spacing.sm }}>
                  <Text style={[typography.label, { color: tokens.text.tertiary }]}>WHY</Text>
                  <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
                    {proposal.rationale}
                  </Text>
                </Card>
              ) : null}

              {proposal.sourcePrompt ? (
                <Card testID="proposal-prompt" style={{ gap: spacing.sm }}>
                  <Text style={[typography.label, { color: tokens.text.tertiary }]}>PROMPT</Text>
                  <Text style={[typography.body, { color: tokens.text.primary }]}>
                    {proposal.sourcePrompt}
                  </Text>
                </Card>
              ) : null}

              <Card testID="proposal-meta" style={{ gap: spacing.sm }}>
                <Text style={[typography.label, { color: tokens.text.tertiary }]}>ORIGIN</Text>
                <MetaRow
                  label="Created by"
                  value={
                    proposal.createdBy === 'switchboard-monitor'
                      ? 'Switchboard monitor'
                      : proposal.createdBy
                  }
                />
                {proposal.appliedBy ? (
                  <MetaRow
                    label="Applied by"
                    value={
                      proposal.appliedBy === 'switchboard-monitor'
                        ? 'Switchboard monitor'
                        : proposal.appliedBy
                    }
                  />
                ) : null}
                {proposal.appliedVersion !== undefined ? (
                  <MetaRow
                    testID="proposal-applied-version"
                    label="Produced"
                    value={`version ${proposal.appliedVersion}`}
                  />
                ) : null}
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Text style={[typography.caption, { color: tokens.text.tertiary, width: 90 }]}>
                    Proposal
                  </Text>
                  <MonoText size="sm" style={{ flex: 1 }} numberOfLines={1}>
                    {proposal.id}
                  </MonoText>
                </View>
              </Card>

              {message ? (
                <Text
                  testID="proposal-message"
                  style={[typography.bodySm, { color: tokens.status.warning }]}
                >
                  {message}
                </Text>
              ) : null}

              {isDraft ? (
                <View style={{ gap: spacing.sm }}>
                  <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                    <Button
                      testID="proposal-reject"
                      label="Reject"
                      variant="secondary"
                      style={{ flex: 1 }}
                      loading={reject.isPending}
                      onPress={() => setConfirm('reject')}
                    />
                    <Button
                      testID="proposal-apply"
                      label="Apply"
                      style={{ flex: 1 }}
                      loading={apply.isPending}
                      onPress={() => setConfirm('apply')}
                    />
                  </View>
                  <Text style={[typography.caption, { color: tokens.text.tertiary }]}>
                    Applying writes a new flag version and an audit entry. Nothing is overwritten.
                  </Text>
                </View>
              ) : (
                <Text
                  testID="proposal-closed"
                  style={[typography.bodySm, { color: tokens.text.tertiary }]}
                >
                  {proposalStatusLabel(proposal.status)} proposals cannot be applied or rejected.
                </Text>
              )}
            </>
          ) : null}
        </ScrollView>
      </AsyncStateView>

      <ConfirmDialog
        testID="proposal-confirm"
        visible={confirm !== null}
        title={confirm === 'apply' ? 'Apply this change?' : 'Reject this proposal?'}
        message={
          confirm === 'apply'
            ? `${proposal?.diff.flagKey ?? 'The flag'} changes as previewed, immediately.`
            : 'The proposal is closed and no flag changes.'
        }
        confirmLabel={confirm === 'apply' ? 'Apply' : 'Reject'}
        destructive={confirm === 'reject'}
        loading={pending}
        onCancel={() => setConfirm(null)}
        onConfirm={() => void run(confirm ?? 'apply')}
      >
        <TextInput
          testID="proposal-reason"
          label="Reason (audit log)"
          value={reason}
          onChangeText={setReason}
          placeholder="Reviewed on call"
          autoCapitalize="sentences"
        />
      </ConfirmDialog>
    </ScreenView>
  );
}

function MetaRow({ label, value, testID }: { label: string; value: string; testID?: string }) {
  const { tokens, typography } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      <Text style={[typography.caption, { color: tokens.text.tertiary, width: 90 }]}>{label}</Text>
      <Text testID={testID} style={[typography.bodySm, { color: tokens.text.primary, flex: 1 }]}>
        {value}
      </Text>
    </View>
  );
}
