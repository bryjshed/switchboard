import Feather from '@expo/vector-icons/Feather';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useCallback, useMemo } from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';

import { AnomalyBanner } from '@features/ai/components/AnomalyBanner';
import { ProposalRow } from '@features/ai/components/ProposalRow';
import { RolloutRow } from '@features/ai/components/RolloutRow';
import { activeRollouts, DEFAULT_WINDOW, windowHours } from '@features/ai/lib/rolloutStats';
import { proposalsListOptions } from '@features/ai/queries/aiQueries';
import { anomaliesOptions, rolloutStatsOptions } from '@features/ai/queries/monitorQueries';
import { flagsListOptions } from '@features/flags/queries/flagQueries';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { useActiveOrgStore } from '@features/orgs/stores/activeOrgStore';
import { envLabel, findEnvId } from '@shared/lib/env';
import { usePullToRefresh } from '@shared/hooks/usePullToRefresh';
import { radius, spacing, useTheme } from '@shared/theme';
import {
  AsyncStateView,
  Card,
  EmptyState,
  PageHeader,
  PressableScale,
  ScreenView,
  SegmentedControl,
  Skeleton,
} from '@shared/ui';

const RECENT_PROPOSALS = 5;
const MONITOR_HOURS = windowHours(DEFAULT_WINDOW);

function MonitorSkeleton() {
  return (
    <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
      {[0, 1, 2].map((i) => (
        <Card key={i} testID={`monitor-skeleton-${i}`} style={{ gap: spacing.md }}>
          <Skeleton width="55%" height={17} radius={6} />
          <Skeleton height={8} radius={999} />
          <Skeleton width="40%" height={12} radius={6} />
        </Card>
      ))}
    </View>
  );
}

/**
 * The healing / optimizing surface.
 *
 * Three stacked answers to "is anything wrong, what is ramping, and what did
 * the system already do about it". Everything is scoped to the active
 * environment, which stays in sync with the Flags tab through the shared store.
 */
export default function MonitorScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  const {
    userId,
    project,
    projectId,
    environments,
    envKey,
    loading: contextLoading,
  } = useActiveContext();
  const setActiveEnvKey = useActiveOrgStore((s) => s.setActiveEnvKey);
  const envId = findEnvId(environments, envKey);

  const flagsQuery = useQuery(flagsListOptions({ userId, projectId }));
  const anomaliesQuery = useQuery(anomaliesOptions(userId, envId));
  const proposalsQuery = useQuery(proposalsListOptions(userId, projectId, undefined, RECENT_PROPOSALS));

  const rollouts = useMemo(
    () => activeRollouts(flagsQuery.data?.items ?? [], envKey),
    [flagsQuery.data, envKey],
  );

  // One stats request per ramping flag. useQueries keeps them independent, so a
  // flag with no metric data never blocks the rest of the list from rendering.
  const statsQueries = useQueries({
    queries: rollouts.map((r) =>
      rolloutStatsOptions(userId, envId, r.flag.key, MONITOR_HOURS),
    ),
  });

  const openFindings = useMemo(
    () => (anomaliesQuery.data ?? []).filter((f) => f.status === 'OPEN'),
    [anomaliesQuery.data],
  );
  const openFlagKeys = useMemo(
    () => new Set(openFindings.map((f) => f.flagKey)),
    [openFindings],
  );

  const refetchAll = useCallback(
    () =>
      Promise.all([
        flagsQuery.refetch(),
        anomaliesQuery.refetch(),
        proposalsQuery.refetch(),
      ]),
    [flagsQuery, anomaliesQuery, proposalsQuery],
  );
  const { refreshing, onRefresh } = usePullToRefresh(refetchAll);

  const envOptions = useMemo(
    () => environments.map((env) => ({ value: env.key, label: envLabel(env.key) })),
    [environments],
  );

  const proposals = proposalsQuery.data?.items ?? [];
  const loading = contextLoading || (flagsQuery.isLoading && !flagsQuery.data);
  const nothingToShow =
    rollouts.length === 0 && openFindings.length === 0 && proposals.length === 0;

  const sectionLabel = (text: string, action?: React.ReactNode) => (
    <View style={{ flexDirection: 'row', alignItems: 'center', marginBottom: spacing.sm }}>
      <Text style={[typography.label, { color: tokens.text.tertiary, flex: 1 }]}>{text}</Text>
      {action}
    </View>
  );

  return (
    <ScreenView testID="monitor-screen">
      <PageHeader
        title="Monitor"
        right={
          <PressableScale
            testID="monitor-ask-ai"
            onPress={() => router.push('/ai/create')}
            hapticKind="light"
            accessibilityRole="button"
            accessibilityLabel="Describe a change for AI"
            disabled={!projectId}
            style={{
              height: 36,
              paddingHorizontal: spacing.md,
              borderRadius: radius.sm,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: spacing.xs,
              backgroundColor: tokens.accent.primary,
              opacity: projectId ? 1 : 0.4,
            }}
          >
            <Feather name="message-square" size={14} color={tokens.text.onAccent} />
            <Text style={[typography.label, { color: tokens.text.onAccent }]}>Ask AI</Text>
          </PressableScale>
        }
      />

      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md }}>
        <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
          {project ? `${project.name} · ${envKey ? envLabel(envKey) : 'no env'}` : 'Choose a project'}
        </Text>
        {envOptions.length > 0 && envKey ? (
          <SegmentedControl
            testID="monitor-env-switcher"
            options={envOptions}
            value={envKey}
            onChange={setActiveEnvKey}
          />
        ) : null}
      </View>

      <AsyncStateView
        testID="monitor-async"
        loading={loading}
        error={flagsQuery.error}
        empty={nothingToShow}
        skeleton={<MonitorSkeleton />}
        emptyState={
          <EmptyState
            testID="monitor-empty"
            icon="activity"
            title="Nothing ramping here"
            message={`No flag in ${envKey ? envLabel(envKey) : 'this environment'} is serving a percentage rollout, and the monitor has not opened any findings.`}
          />
        }
        onRetry={() => void refetchAll()}
      >
        <ScrollView
          testID="monitor-scroll"
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.xxl,
            gap: spacing.xl,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tokens.text.tertiary}
            />
          }
        >
          {/* No findings means NO banner — never an "all clear" block. */}
          <AnomalyBanner
            findings={openFindings}
            onPress={(finding) =>
              router.push(
                `/flag/${encodeURIComponent(finding.flagKey)}/monitor?env=${encodeURIComponent(envKey ?? '')}`,
              )
            }
          />

          {rollouts.length > 0 ? (
            <View>
              {sectionLabel('ACTIVE ROLLOUTS')}
              <View style={{ gap: spacing.md }}>
                {rollouts.map((rollout, i) => (
                  <RolloutRow
                    key={rollout.flag.id}
                    rollout={rollout}
                    stats={statsQueries[i]?.data}
                    hasOpenFinding={openFlagKeys.has(rollout.flag.key)}
                    onPress={() =>
                      router.push(
                        `/flag/${encodeURIComponent(rollout.flag.key)}/monitor?env=${encodeURIComponent(rollout.envKey)}`,
                      )
                    }
                  />
                ))}
              </View>
            </View>
          ) : null}

          {/* Always rendered, even empty: it is the only way into the full
              proposals list, and an empty line here is itself information. */}
          <View>
            {sectionLabel(
              'RECENT AI ACTIVITY',
              <PressableScale
                testID="monitor-all-proposals"
                onPress={() => router.push('/ai/proposals')}
                hapticKind="selection"
                accessibilityRole="button"
                accessibilityLabel="See all proposals"
              >
                <Text style={[typography.label, { color: tokens.text.secondary }]}>See all</Text>
              </PressableScale>,
            )}
            {proposals.length > 0 ? (
              <View style={{ gap: spacing.md }}>
                {proposals.map((proposal) => (
                  <ProposalRow
                    key={proposal.id}
                    proposal={proposal}
                    onPress={() => router.push(`/ai/proposal/${proposal.id}`)}
                  />
                ))}
              </View>
            ) : (
              <Text
                testID="monitor-no-proposals"
                style={[typography.bodySm, { color: tokens.text.tertiary }]}
              >
                No proposals yet. Changes drafted from a prompt, and rollbacks the monitor
                suggests, show up here.
              </Text>
            )}
          </View>
        </ScrollView>
      </AsyncStateView>
    </ScreenView>
  );
}
