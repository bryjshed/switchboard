import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, ScrollView, Text, View } from 'react-native';

import { useRollbackMutation } from '@features/flags/mutations/flagMutations';
import { flagDetailOptions, flagVersionsOptions } from '@features/flags/queries/flagQueries';
import { describeServe, targetingCounts, variationLabel } from '@features/flags/lib/targeting';
import type { FlagVersionResponse } from '@features/flags/types';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { orderEnvKeys, envLabel } from '@shared/lib/env';
import { dateTimeLabel, relativeTime } from '@shared/lib/time';
import { usePullToRefresh } from '@shared/hooks/usePullToRefresh';
import { spacing, useTheme } from '@shared/theme';
import {
  AsyncStateView,
  BackButton,
  Badge,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  MonoText,
  PageHeader,
  PressableScale,
  ScreenView,
  Sheet,
  Skeleton,
  TextInput,
} from '@shared/ui';

export default function HistoryScreen() {
  const { tokens, typography } = useTheme();
  const params = useLocalSearchParams<{ flagKey: string; env?: string }>();
  const flagKey = params.flagKey;
  const {
    userId,
    orgId,
    projectId,
    envKey: activeEnvKey,
    environments,
    loading: contextLoading,
  } = useActiveContext();

  // The chip selection is an override; until the user taps one the env comes
  // from the route param, then the app-wide active env once it resolves.
  const [chosenEnvKey, setEnvKey] = useState<string | undefined>(undefined);
  const envKey = chosenEnvKey ?? params.env ?? activeEnvKey;

  const flagQuery = useQuery(flagDetailOptions(userId, projectId, flagKey));
  const versionsQuery = useQuery(flagVersionsOptions(userId, projectId, flagKey, envKey));
  const { refreshing, onRefresh } = usePullToRefresh(versionsQuery.refetch);
  const rollback = useRollbackMutation({ userId, orgId, projectId });

  const [selected, setSelected] = useState<FlagVersionResponse | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const variations = flagQuery.data?.variations ?? [];
  const envChips = useMemo(() => {
    const fromFlag = flagQuery.data?.envConfigs.map((e) => ({ envKey: e.envKey }));
    const fromProject = environments.map((e) => ({ envKey: e.key }));
    return orderEnvKeys(fromFlag ?? fromProject);
  }, [flagQuery.data, environments]);

  const versions = versionsQuery.data?.items ?? [];
  const currentVersion = versions[0]?.versionNumber;

  const doRollback = async () => {
    if (!selected || !envKey || !flagKey) return;
    setConfirming(false);
    setMessage(null);
    try {
      await rollback.mutateAsync({
        flagKey,
        envKey,
        toVersion: selected.versionNumber,
        reason: reason.trim() || `Rolled back to v${selected.versionNumber}`,
      });
      setReason('');
      setSelected(null);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Rollback failed');
    }
  };

  return (
    <ScreenView bottomInset testID="history-screen">
      <PageHeader
        title="History"
        subtitle={flagKey}
        left={<BackButton />}
        testID="history-header"
      />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            {envChips.map((env) => (
              <Chip
                key={env.envKey}
                testID={`history-env-${env.envKey}`}
                label={envLabel(env.envKey)}
                selected={env.envKey === envKey}
                onPress={() => setEnvKey(env.envKey)}
              />
            ))}
          </View>
        </ScrollView>
      </View>

      <AsyncStateView
        testID="history-async"
        loading={contextLoading || versionsQuery.isLoading}
        error={versionsQuery.error}
        empty={versions.length === 0}
        skeleton={
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} height={72} radius={14} />
            ))}
          </View>
        }
        emptyState={
          <EmptyState
            testID="history-empty"
            icon="clock"
            title="No versions yet"
            message="Every config write on this environment lands here."
          />
        }
        onRetry={() => versionsQuery.refetch()}
      >
        <FlatList
          testID="history-list"
          data={versions}
          keyExtractor={(item) => String(item.versionNumber)}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tokens.text.tertiary}
            />
          }
          renderItem={({ item }) => (
            <PressableScale
              testID={`history-version-${item.versionNumber}`}
              onPress={() => setSelected(item)}
              accessibilityRole="button"
              accessibilityLabel={`Version ${item.versionNumber}`}
              style={{ marginBottom: spacing.md }}
            >
              <Card style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <MonoText color={tokens.text.primary}>v{item.versionNumber}</MonoText>
                  {item.versionNumber === currentVersion ? (
                    <Badge label="Current" tone="accent" />
                  ) : null}
                  <View style={{ flex: 1 }} />
                  <Badge
                    label={item.enabled ? 'On' : 'Off'}
                    tone={item.enabled ? 'success' : 'neutral'}
                  />
                  {item.killSwitchActive ? <Badge label="Killed" tone="error" /> : null}
                </View>
                {item.versionNote ? (
                  <Text style={[typography.bodySm, { color: tokens.text.primary }]}>
                    {item.versionNote}
                  </Text>
                ) : null}
                <Text style={[typography.caption, { color: tokens.text.tertiary }]}>
                  {item.createdBy} · {relativeTime(item.createdAt)}
                </Text>
              </Card>
            </PressableScale>
          )}
        />
      </AsyncStateView>

      <Sheet
        visible={!!selected}
        onClose={() => setSelected(null)}
        title={selected ? `Version ${selected.versionNumber}` : undefined}
        testID="history-sheet"
      >
        {selected ? (
          <View style={{ gap: spacing.md }}>
            <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
              {selected.createdBy} · {dateTimeLabel(selected.createdAt)}
            </Text>
            {selected.versionNote ? (
              <Text style={[typography.body, { color: tokens.text.primary }]}>
                {selected.versionNote}
              </Text>
            ) : null}
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Badge
                label={selected.enabled ? 'Enabled' : 'Disabled'}
                tone={selected.enabled ? 'success' : 'neutral'}
              />
              {selected.killSwitchActive ? <Badge label="Kill switch on" tone="error" /> : null}
              {selected.createdFromProposalId ? <Badge label="From AI" tone="accent" /> : null}
            </View>
            <View style={{ gap: spacing.xs }}>
              <SummaryLine
                label="Fallthrough"
                value={describeServe(selected.config.fallthrough, variations)}
              />
              <SummaryLine
                label="Off variation"
                value={variationLabel(variations, selected.config.offVariationId)}
              />
              <SummaryLine
                label="Default variation"
                value={variationLabel(variations, selected.config.defaultVariationId)}
              />
              <SummaryLine
                label="Rules"
                value={`${targetingCounts(selected.config).ruleCount} · ${
                  targetingCounts(selected.config).targetCount
                } individual targets`}
              />
            </View>
            {message ? (
              <Text style={[typography.bodySm, { color: tokens.status.error }]}>{message}</Text>
            ) : null}
            <Button
              testID="history-rollback"
              label={`Roll back to v${selected.versionNumber}`}
              variant="destructive"
              disabled={selected.versionNumber === currentVersion}
              loading={rollback.isPending}
              onPress={() => setConfirming(true)}
            />
          </View>
        ) : null}
      </Sheet>

      <ConfirmDialog
        testID="history-rollback-confirm"
        visible={confirming}
        title={selected ? `Roll back to v${selected.versionNumber}?` : 'Roll back?'}
        message="This writes a new version copying that snapshot. The history is kept."
        confirmLabel="Roll back"
        destructive
        loading={rollback.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void doRollback()}
      >
        <TextInput
          testID="history-rollback-reason"
          label="Reason (audit log)"
          value={reason}
          onChangeText={setReason}
          placeholder="Regression in checkout"
        />
      </ConfirmDialog>
    </ScreenView>
  );
}

function SummaryLine({ label, value }: { label: string; value: string }) {
  const { tokens, typography } = useTheme();
  return (
    <View style={{ flexDirection: 'row', gap: spacing.sm }}>
      <Text style={[typography.label, { color: tokens.text.tertiary, width: 120 }]}>{label}</Text>
      <Text style={[typography.bodySm, { flex: 1, color: tokens.text.primary }]}>{value}</Text>
    </View>
  );
}
