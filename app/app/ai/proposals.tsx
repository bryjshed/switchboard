import { useQuery } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { FlatList, RefreshControl, View } from 'react-native';

import { ProposalRow } from '@features/ai/components/ProposalRow';
import { proposalsListOptions } from '@features/ai/queries/aiQueries';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { usePullToRefresh } from '@shared/hooks/usePullToRefresh';
import { spacing, useTheme } from '@shared/theme';
import type { ProposalStatus } from '@shared/api/types';
import {
  AsyncStateView,
  BackButton,
  Card,
  EmptyState,
  PageHeader,
  ScreenView,
  SegmentedControl,
  Skeleton,
} from '@shared/ui';

const ALL = 'ALL';
type Filter = typeof ALL | ProposalStatus;

const FILTERS: { value: Filter; label: string }[] = [
  { value: ALL, label: 'All' },
  { value: 'DRAFT', label: 'Draft' },
  { value: 'APPLIED', label: 'Applied' },
  { value: 'REJECTED', label: 'Rejected' },
];

function ProposalsSkeleton() {
  return (
    <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
      {[0, 1, 2, 3].map((i) => (
        <Card key={i} testID={`proposals-skeleton-${i}`} style={{ gap: spacing.sm }}>
          <Skeleton width="45%" height={20} radius={999} />
          <Skeleton width="60%" height={14} radius={6} />
        </Card>
      ))}
    </View>
  );
}

/** Every proposal in the project, filterable by status. */
export default function ProposalsScreen() {
  const { tokens } = useTheme();
  const router = useRouter();
  const { userId, projectId } = useActiveContext();
  const [filter, setFilter] = useState<Filter>(ALL);

  const status = filter === ALL ? undefined : filter;
  const proposalsQuery = useQuery(proposalsListOptions(userId, projectId, status, 50));
  const { refreshing, onRefresh } = usePullToRefresh(proposalsQuery.refetch);

  const items = useMemo(() => proposalsQuery.data?.items ?? [], [proposalsQuery.data]);

  return (
    <ScreenView bottomInset testID="proposals-screen">
      <PageHeader
        title="AI proposals"
        left={<BackButton fallbackHref="/monitor" />}
        testID="proposals-header"
      />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
        <SegmentedControl
          testID="proposals-filter"
          options={FILTERS}
          value={filter}
          onChange={setFilter}
        />
      </View>
      <AsyncStateView
        testID="proposals-async"
        loading={proposalsQuery.isLoading && !proposalsQuery.data}
        error={proposalsQuery.error}
        empty={items.length === 0}
        skeleton={<ProposalsSkeleton />}
        emptyState={
          <EmptyState
            testID="proposals-empty"
            icon="inbox"
            title={filter === ALL ? 'No proposals yet' : 'Nothing with that status'}
            message={
              filter === ALL
                ? 'Changes drafted from a prompt, and rollbacks the monitor suggests, land here for review.'
                : 'Try another status filter.'
            }
          />
        }
        onRetry={() => proposalsQuery.refetch()}
      >
        <FlatList
          testID="proposals-list"
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tokens.text.tertiary}
            />
          }
          renderItem={({ item }) => (
            <View style={{ marginBottom: spacing.md }}>
              <ProposalRow
                proposal={item}
                onPress={() => router.push(`/ai/proposal/${item.id}`)}
              />
            </View>
          )}
        />
      </AsyncStateView>
    </ScreenView>
  );
}
