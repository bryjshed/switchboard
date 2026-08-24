import { useInfiniteQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, RefreshControl, ScrollView, Text, View } from 'react-native';

import {
  actionLabel,
  actionTone,
  groupByDay,
  versionDelta,
  type AuditRow,
} from '@features/audit/lib/auditPresentation';
import { orgAuditOptions, projectAuditOptions } from '@features/audit/queries/auditQueries';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { envLabel } from '@shared/lib/env';
import { relativeTime } from '@shared/lib/time';
import { usePullToRefresh } from '@shared/hooks/usePullToRefresh';
import { spacing, useTheme } from '@shared/theme';
import {
  AsyncStateView,
  Badge,
  Card,
  Chip,
  EmptyState,
  MonoText,
  PageHeader,
  PressableScale,
  ScreenView,
  Skeleton,
} from '@shared/ui';

const ALL = '__all__';

export default function ActivityScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  const { userId, orgId, projects, loading: contextLoading } = useActiveContext();
  const [filter, setFilter] = useState<string>(ALL);

  // A project filter switches to the project feed so the narrowing happens
  // server-side; filtering the org feed client-side would thin every page.
  const orgFeed = useInfiniteQuery({
    ...orgAuditOptions(userId, orgId),
    enabled: !!userId && !!orgId && filter === ALL,
  });
  const projectFeed = useInfiniteQuery({
    ...projectAuditOptions(userId, filter === ALL ? undefined : filter),
    enabled: !!userId && filter !== ALL,
  });
  const feed = filter === ALL ? orgFeed : projectFeed;

  const { refreshing, onRefresh } = usePullToRefresh(feed.refetch);

  const rows = useMemo(
    () => groupByDay(feed.data?.pages.flatMap((page) => page.items) ?? []),
    [feed.data],
  );

  return (
    <ScreenView testID="activity-screen">
      <PageHeader title="Activity" subtitle="Every change across your org" />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Chip
              testID="activity-filter-all"
              label="All projects"
              selected={filter === ALL}
              onPress={() => setFilter(ALL)}
            />
            {projects.map((project) => (
              <Chip
                key={project.id}
                testID={`activity-filter-${project.key}`}
                label={project.name}
                selected={filter === project.id}
                onPress={() => setFilter(project.id)}
              />
            ))}
          </View>
        </ScrollView>
      </View>

      <AsyncStateView
        testID="activity-async"
        loading={contextLoading || feed.isLoading}
        error={feed.error}
        empty={rows.length === 0}
        skeleton={
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <Skeleton key={i} height={64} radius={14} />
            ))}
          </View>
        }
        emptyState={
          <EmptyState
            testID="activity-empty"
            icon="list"
            title="No activity yet"
            message="Flag changes, kill switches, and rollbacks land here as they happen."
          />
        }
        onRetry={() => feed.refetch()}
      >
        <FlatList
          testID="activity-list"
          data={rows}
          keyExtractor={(row: AuditRow) => row.id}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }}
          onEndReachedThreshold={0.5}
          onEndReached={() => {
            if (feed.hasNextPage && !feed.isFetchingNextPage) void feed.fetchNextPage();
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tokens.text.tertiary}
            />
          }
          ListFooterComponent={
            feed.isFetchingNextPage ? (
              <ActivityIndicator
                testID="activity-loading-more"
                style={{ paddingVertical: spacing.lg }}
                color={tokens.text.tertiary}
              />
            ) : null
          }
          renderItem={({ item }) =>
            item.type === 'day' ? (
              <Text
                testID={`activity-day-${item.id}`}
                style={[
                  typography.label,
                  {
                    color: tokens.text.tertiary,
                    marginTop: spacing.md,
                    marginBottom: spacing.sm,
                  },
                ]}
              >
                {item.label.toUpperCase()}
              </Text>
            ) : (
              <PressableScale
                testID={`activity-entry-${item.entry.id}`}
                accessibilityRole="button"
                accessibilityLabel={`${actionLabel(item.entry.action)} ${item.entry.flagKey ?? ''}`}
                onPress={
                  item.entry.flagKey
                    ? () => router.push(`/flag/${encodeURIComponent(item.entry.flagKey as string)}`)
                    : undefined
                }
                style={{ marginBottom: spacing.sm }}
              >
                <Card style={{ gap: spacing.sm }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                    <Badge
                      label={actionLabel(item.entry.action)}
                      tone={actionTone(item.entry.action)}
                    />
                    {item.entry.flagKey ? (
                      <MonoText size="sm" numberOfLines={1} style={{ flex: 1 }}>
                        {item.entry.flagKey}
                      </MonoText>
                    ) : (
                      <View style={{ flex: 1 }} />
                    )}
                    {item.entry.envKey ? (
                      <Text style={[typography.caption, { color: tokens.text.tertiary }]}>
                        {envLabel(item.entry.envKey)}
                      </Text>
                    ) : null}
                  </View>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                    <Text
                      style={[typography.caption, { flex: 1, color: tokens.text.secondary }]}
                      numberOfLines={1}
                    >
                      {item.entry.actor}
                      {versionDelta(item.entry) ? ` · ${versionDelta(item.entry)}` : ''}
                    </Text>
                    <Text style={[typography.caption, { color: tokens.text.tertiary }]}>
                      {relativeTime(item.entry.createdAt)}
                    </Text>
                  </View>
                  {item.entry.reason ? (
                    <Text
                      style={[typography.bodySm, { color: tokens.text.secondary }]}
                      numberOfLines={2}
                    >
                      {item.entry.reason}
                    </Text>
                  ) : null}
                </Card>
              </PressableScale>
            )
          }
        />
      </AsyncStateView>
    </ScreenView>
  );
}
