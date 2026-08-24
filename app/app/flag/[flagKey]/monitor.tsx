import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useCallback, useMemo, useState } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';

import { AnomalyCard } from '@features/ai/components/AnomalyCard';
import { VariantStatsCard } from '@features/ai/components/VariantStatsCard';
import { isConflict } from '@features/ai/lib/aiErrors';
import {
  DEFAULT_WINDOW,
  STATS_WINDOWS,
  erroringVariationIds,
  formatCount,
  leadingVariationId,
  totalEvals,
  windowHours,
  type StatsWindowValue,
} from '@features/ai/lib/rolloutStats';
import { assignVariantColors } from '@features/ai/lib/variantPalette';
import { useAckAnomalyMutation } from '@features/ai/mutations/monitorMutations';
import { anomaliesOptions, rolloutStatsOptions } from '@features/ai/queries/monitorQueries';
import { useKillSwitchMutation, useRollbackMutation } from '@features/flags/mutations/flagMutations';
import { flagDetailOptions, flagVersionsOptions } from '@features/flags/queries/flagQueries';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { envLabel, envTone, findEnvId } from '@shared/lib/env';
import { usePullToRefresh } from '@shared/hooks/usePullToRefresh';
import { spacing, useTheme } from '@shared/theme';
import {
  AsyncStateView,
  BackButton,
  Badge,
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  MonoText,
  PageHeader,
  ScreenView,
  SegmentedControl,
  Skeleton,
} from '@shared/ui';

function StatsSkeleton() {
  return (
    <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
      {[0, 1].map((i) => (
        <Card key={i} testID={`rollout-skeleton-${i}`} style={{ gap: spacing.md }}>
          <Skeleton width="45%" height={17} radius={6} />
          <Skeleton height={6} radius={999} />
          <Skeleton height={6} radius={999} />
          <Skeleton height={28} radius={6} />
        </Card>
      ))}
    </View>
  );
}

/**
 * Per-variant comparison for one flag in one environment.
 *
 * The question this screen answers is "which variant is worse, and by how
 * much" — so every rate is a bar on a shared scale, every variant carries an
 * hourly sparkline, and the two verdicts (leading on conversion, erroring
 * badly) are stated rather than left to be read off numbers.
 */
export default function RolloutMonitorScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  const { flagKey, env } = useLocalSearchParams<{ flagKey: string; env?: string }>();
  const { userId, orgId, projectId, environments, envKey: activeEnvKey } = useActiveContext();
  const envKey = env || activeEnvKey;
  const envId = findEnvId(environments, envKey);

  const [window, setWindow] = useState<StatsWindowValue>(DEFAULT_WINDOW);
  const [rollbackVisible, setRollbackVisible] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const hours = windowHours(window);
  const flagQuery = useQuery(flagDetailOptions(userId, projectId, flagKey));
  const statsQuery = useQuery(rolloutStatsOptions(userId, envId, flagKey, hours));
  const anomaliesQuery = useQuery(anomaliesOptions(userId, envId));
  const versionsQuery = useQuery(flagVersionsOptions(userId, projectId, flagKey, envKey));

  const ackAnomaly = useAckAnomalyMutation({ userId, envId });
  const rollback = useRollbackMutation({ userId, orgId, projectId });
  const killSwitch = useKillSwitchMutation({ userId, orgId, projectId });

  const flag = flagQuery.data;
  const envConfig = flag?.envConfigs.find((e) => e.envKey === envKey);
  const stats = statsQuery.data;
  const totals = useMemo(() => stats?.totals ?? [], [stats]);

  const colors = assignVariantColors(
    tokens,
    totals.map((v) => v.variationId),
  );
  const leading = leadingVariationId(totals);
  const erroring = useMemo(() => new Set(erroringVariationIds(totals)), [totals]);
  const maxErrorRate = totals.reduce((m, v) => Math.max(m, v.errorRate), 0);
  const maxConversionRate = totals.reduce((m, v) => Math.max(m, v.conversionRate), 0);

  const findings = useMemo(
    () => (anomaliesQuery.data ?? []).filter((f) => f.flagKey === flagKey),
    [anomaliesQuery.data, flagKey],
  );

  // The version immediately before the live one: what "roll back now" restores.
  const previousVersion = useMemo(() => {
    const items = versionsQuery.data?.items ?? [];
    if (!envConfig) return undefined;
    return items.find((v) => v.versionNumber < envConfig.version);
  }, [versionsQuery.data, envConfig]);

  const refetchAll = useCallback(
    () => Promise.all([flagQuery.refetch(), statsQuery.refetch(), anomaliesQuery.refetch()]),
    [flagQuery, statsQuery, anomaliesQuery],
  );
  const { refreshing, onRefresh } = usePullToRefresh(refetchAll);

  const onAck = async (anomalyId: string) => {
    setMessage(null);
    try {
      await ackAnomaly.mutateAsync({ anomalyId });
    } catch (e) {
      setMessage(
        isConflict(e)
          ? 'That finding was already acknowledged.'
          : e instanceof Error
            ? e.message
            : 'Acknowledge failed',
      );
    }
  };

  const confirmRollback = async () => {
    if (!flagKey || !envKey) return;
    setRollbackVisible(false);
    setMessage(null);
    try {
      if (previousVersion) {
        await rollback.mutateAsync({
          flagKey,
          envKey,
          toVersion: previousVersion.versionNumber,
          reason: 'Rolled back from mobile monitor',
        });
        setMessage(`Rolled back to v${previousVersion.versionNumber}.`);
      } else {
        await killSwitch.mutateAsync({
          flagKey,
          envKey,
          active: true,
          reason: 'Killed from mobile monitor',
        });
        setMessage('Kill switch on. All traffic serves the off variation.');
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Rollback failed');
    }
  };

  const windowOptions = STATS_WINDOWS.map((w) => ({ value: w.value, label: w.label }));
  const rollbackLabel = previousVersion
    ? `Roll back to v${previousVersion.versionNumber}`
    : 'Turn on kill switch';

  return (
    <ScreenView bottomInset testID="rollout-monitor-screen">
      <PageHeader
        title={flag?.name ?? flagKey ?? 'Rollout'}
        subtitle={envKey ? `${envLabel(envKey)} · rollout health` : undefined}
        left={<BackButton fallbackHref="/monitor" />}
        testID="rollout-monitor-header"
      />
      <AsyncStateView
        testID="rollout-monitor-async"
        loading={statsQuery.isLoading && !statsQuery.data}
        error={statsQuery.error}
        skeleton={<StatsSkeleton />}
        onRetry={() => void refetchAll()}
      >
        <ScrollView
          testID="rollout-monitor-scroll"
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.xxl,
            gap: spacing.lg,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tokens.text.tertiary}
            />
          }
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <MonoText style={{ flex: 1 }} numberOfLines={1}>
              {flagKey}
            </MonoText>
            {envKey ? <Badge label={envLabel(envKey)} tone={envTone(envKey)} /> : null}
          </View>

          <SegmentedControl
            testID="rollout-window"
            options={windowOptions}
            value={window}
            onChange={setWindow}
          />

          <Text testID="rollout-total-evals" style={[typography.bodySm, { color: tokens.text.secondary }]}>
            {formatCount(totalEvals(totals))} evaluations over the last{' '}
            {STATS_WINDOWS.find((w) => w.value === window)?.label}
          </Text>

          {totals.length === 0 ? (
            <EmptyState
              testID="rollout-no-stats"
              icon="bar-chart-2"
              title="No evaluations yet"
              message="Once SDKs evaluate this flag in this environment, per-variant rates show up here."
            />
          ) : (
            <View style={{ gap: spacing.md }}>
              {totals.map((variant) => (
                <VariantStatsCard
                  key={variant.variationId}
                  variant={variant}
                  value={flag?.variations.find((v) => v.id === variant.variationId)?.value}
                  color={colors[variant.variationId]}
                  buckets={stats?.buckets ?? []}
                  maxErrorRate={maxErrorRate}
                  maxConversionRate={maxConversionRate}
                  leading={leading === variant.variationId}
                  erroring={erroring.has(variant.variationId)}
                />
              ))}
            </View>
          )}

          {findings.length > 0 ? (
            <View style={{ gap: spacing.md }}>
              <Text style={[typography.label, { color: tokens.text.tertiary }]}>FINDINGS</Text>
              {findings.map((finding) => (
                <AnomalyCard
                  key={finding.id}
                  finding={finding}
                  acknowledging={ackAnomaly.isPending}
                  onAcknowledge={() => void onAck(finding.id)}
                  onReviewProposal={
                    finding.suggestedProposalId
                      ? () => router.push(`/ai/proposal/${finding.suggestedProposalId}`)
                      : undefined
                  }
                />
              ))}
            </View>
          ) : null}

          {message ? (
            <Text testID="rollout-message" style={[typography.bodySm, { color: tokens.text.secondary }]}>
              {message}
            </Text>
          ) : null}

          <View style={{ gap: spacing.sm }}>
            <Button
              testID="rollout-rollback"
              label={rollbackLabel}
              variant="destructive"
              loading={rollback.isPending || killSwitch.isPending}
              disabled={!envConfig}
              onPress={() => setRollbackVisible(true)}
            />
            <Button
              testID="rollout-open-flag"
              label="Open flag"
              variant="secondary"
              onPress={() => router.push(`/flag/${encodeURIComponent(flagKey ?? '')}`)}
            />
          </View>
        </ScrollView>
      </AsyncStateView>

      <ConfirmDialog
        testID="rollout-rollback-confirm"
        visible={rollbackVisible}
        title={previousVersion ? `Roll back ${flagKey}?` : `Kill ${flagKey}?`}
        message={
          previousVersion
            ? `Restores the version ${previousVersion.versionNumber} config in ${envKey ? envLabel(envKey) : 'this environment'}. This writes a new version; nothing is erased.`
            : `There is no earlier version to restore, so this turns on the kill switch instead. All traffic serves the off variation immediately.`
        }
        confirmLabel={previousVersion ? 'Roll back' : 'Kill'}
        destructive
        loading={rollback.isPending || killSwitch.isPending}
        onCancel={() => setRollbackVisible(false)}
        onConfirm={() => void confirmRollback()}
      />
    </ScreenView>
  );
}
