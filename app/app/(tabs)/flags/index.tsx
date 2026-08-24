import Feather from '@expo/vector-icons/Feather';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, Text, View } from 'react-native';
import Animated, { FadeInDown, useReducedMotion } from 'react-native-reanimated';

import { CreateFlagSheet } from '@features/flags/components/CreateFlagSheet';
import { FlagCard } from '@features/flags/components/FlagCard';
import { useKillSwitchMutation } from '@features/flags/mutations/flagMutations';
import { flagsListOptions } from '@features/flags/queries/flagQueries';
import { OrgProjectSwitcher } from '@features/orgs/components/OrgProjectSwitcher';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { useActiveOrgStore } from '@features/orgs/stores/activeOrgStore';
import { envLabel } from '@shared/lib/env';
import { usePullToRefresh } from '@shared/hooks/usePullToRefresh';
import { radius, spacing, useTheme } from '@shared/theme';
import {
  AsyncStateView,
  Card,
  EmptyState,
  PageHeader,
  PressableScale,
  ScreenView,
  SearchBar,
  SegmentedControl,
  Skeleton,
} from '@shared/ui';

/** Card-shaped placeholder: same padding, line heights, and pill row as FlagCard. */
function FlagCardSkeleton() {
  return (
    <Card>
      <View style={{ flexDirection: 'row', gap: spacing.md }}>
        <View style={{ flex: 1, gap: spacing.sm }}>
          <Skeleton width="62%" height={17} radius={6} />
          <Skeleton width="38%" height={12} radius={6} />
        </View>
        <View style={{ flexDirection: 'row', gap: spacing.xs }}>
          {[0, 1, 2].map((i) => (
            <Skeleton key={i} width={46} height={20} radius={radius.pill} />
          ))}
        </View>
      </View>
    </Card>
  );
}

function FlagListSkeleton() {
  return (
    <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
      {[0, 1, 2, 3].map((i) => (
        <View key={i} testID={`flags-skeleton-${i}`}>
          <FlagCardSkeleton />
        </View>
      ))}
    </View>
  );
}

export default function FlagsScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const reducedMotion = useReducedMotion();
  const {
    userId,
    orgId,
    project,
    projectId,
    environments,
    envKey,
    hasNoProjects,
    loading: contextLoading,
  } = useActiveContext();
  const setActiveEnvKey = useActiveOrgStore((s) => s.setActiveEnvKey);

  const [search, setSearch] = useState('');
  const [switcherVisible, setSwitcherVisible] = useState(false);
  const [createVisible, setCreateVisible] = useState(false);

  const flagsQuery = useQuery(flagsListOptions({ userId, projectId }));
  const { refreshing, onRefresh } = usePullToRefresh(flagsQuery.refetch);
  const killSwitch = useKillSwitchMutation({ userId, orgId, projectId });

  const envOptions = useMemo(
    () => environments.map((env) => ({ value: env.key, label: envLabel(env.key) })),
    [environments],
  );

  // Client-side narrowing: the list response is small and already loaded, so
  // filtering here keeps typing instant instead of round-tripping ?query=.
  const flags = useMemo(() => {
    const items = flagsQuery.data?.items ?? [];
    const needle = search.trim().toLowerCase();
    if (!needle) return items;
    return items.filter(
      (f) => f.key.toLowerCase().includes(needle) || f.name.toLowerCase().includes(needle),
    );
  }, [flagsQuery.data, search]);

  const subtitle = project
    ? `${project.name} · ${envKey ? envLabel(envKey) : 'no env'}`
    : 'Choose a project';

  return (
    <ScreenView testID="flags-screen">
      <PageHeader
        title="Flags"
        right={
          <PressableScale
            testID="flags-create"
            onPress={() => setCreateVisible(true)}
            hapticKind="light"
            accessibilityRole="button"
            accessibilityLabel="New flag"
            disabled={!projectId}
            style={{
              width: 36,
              height: 36,
              borderRadius: radius.sm,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: tokens.accent.primary,
              opacity: projectId ? 1 : 0.4,
            }}
          >
            <Feather name="plus" size={20} color={tokens.text.onAccent} />
          </PressableScale>
        }
      />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md, gap: spacing.md }}>
        <PressableScale
          testID="flags-context-switch"
          onPress={() => setSwitcherVisible(true)}
          hapticKind="selection"
          accessibilityRole="button"
          accessibilityLabel="Switch org, project, or environment"
          style={{ alignSelf: 'flex-start' }}
        >
          <SubtitleRow label={subtitle} />
        </PressableScale>
        {envOptions.length > 0 && envKey ? (
          <SegmentedControl
            testID="flags-env-switcher"
            options={envOptions}
            value={envKey}
            onChange={setActiveEnvKey}
          />
        ) : null}
        <SearchBar
          testID="flags-search"
          value={search}
          onChangeText={setSearch}
          placeholder="Search flags"
        />
      </View>
      <AsyncStateView
        testID="flags-async"
        loading={contextLoading || flagsQuery.isLoading}
        error={flagsQuery.error}
        empty={flags.length === 0}
        skeleton={<FlagListSkeleton />}
        emptyState={
          hasNoProjects ? (
            <EmptyState
              testID="flags-empty"
              icon="folder"
              title="No projects yet"
              message="Create a project in the web console, then it shows up here."
            />
          ) : search.trim() ? (
            <EmptyState
              testID="flags-empty"
              icon="search"
              title="No matches"
              message={`Nothing matches "${search.trim()}" in this project.`}
            />
          ) : (
            <EmptyState
              testID="flags-empty"
              icon="flag"
              title="No flags yet"
              message="Flags you create show up here with a state pill per environment."
              actionLabel="New flag"
              onAction={() => setCreateVisible(true)}
            />
          )
        }
        onRetry={() => flagsQuery.refetch()}
      >
        <FlatList
          testID="flags-list"
          data={flags}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tokens.text.tertiary}
            />
          }
          renderItem={({ item, index }) => (
            <Animated.View
              entering={
                reducedMotion ? undefined : FadeInDown.delay(Math.min(index, 6) * 60).springify()
              }
              style={{ marginBottom: spacing.md }}
            >
              <FlagCard
                flag={item}
                activeEnvKey={envKey ?? ''}
                onPress={() => router.push(`/flag/${encodeURIComponent(item.key)}`)}
                onKillSwitch={(nextActive) => {
                  if (!envKey) return;
                  killSwitch.mutate({
                    flagKey: item.key,
                    envKey,
                    active: nextActive,
                    reason: nextActive ? 'Killed from mobile' : 'Released from mobile',
                  });
                }}
              />
            </Animated.View>
          )}
        />
      </AsyncStateView>

      <OrgProjectSwitcher visible={switcherVisible} onClose={() => setSwitcherVisible(false)} />
      <CreateFlagSheet
        visible={createVisible}
        onClose={() => setCreateVisible(false)}
        scope={{ userId, orgId, projectId }}
        onCreated={(flagKey) => {
          setCreateVisible(false);
          router.push(`/flag/${encodeURIComponent(flagKey)}`);
        }}
      />
    </ScreenView>
  );
}

function SubtitleRow({ label }: { label: string }) {
  const { tokens, typography } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
      <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>{label}</Text>
      <Feather name="chevron-down" size={14} color={tokens.text.tertiary} />
    </View>
  );
}
