import Feather from '@expo/vector-icons/Feather';
import { useQueries, useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React from 'react';
import { RefreshControl, ScrollView, Text, View } from 'react-native';

import { anomaliesOptions } from '@features/ai/queries/monitorQueries';
import { EnvConfigCard } from '@features/flags/components/EnvConfigCard';
import { flagDetailOptions } from '@features/flags/queries/flagQueries';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { orderEnvKeys } from '@shared/lib/env';
import { usePullToRefresh } from '@shared/hooks/usePullToRefresh';
import { radius, spacing, useTheme } from '@shared/theme';
import {
  AsyncStateView,
  BackButton,
  Badge,
  Card,
  Chip,
  MonoText,
  PageHeader,
  PressableScale,
  ScreenView,
  Skeleton,
} from '@shared/ui';

function DetailSkeleton() {
  return (
    <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
      {[0, 1, 2].map((i) => (
        <Card key={i} testID={`flag-detail-skeleton-${i}`} style={{ gap: spacing.md }}>
          <Skeleton width="40%" height={20} radius={999} />
          <Skeleton height={40} />
          <Skeleton width="70%" height={14} />
        </Card>
      ))}
    </View>
  );
}

export default function FlagDetailScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  const { flagKey } = useLocalSearchParams<{ flagKey: string }>();
  const { userId, orgId, projectId, environments, loading: contextLoading } = useActiveContext();

  const flagQuery = useQuery(flagDetailOptions(userId, projectId, flagKey));
  // One OPEN-findings read per environment so the chip lands on the right card.
  // Small responses, 10s staleTime, and shared with the Monitor tab's cache.
  const anomalyQueries = useQueries({
    queries: environments.map((env) => anomaliesOptions(userId, env.id, 'OPEN')),
  });
  const openFindingsByEnv: Record<string, number> = {};
  environments.forEach((env, i) => {
    openFindingsByEnv[env.key] = (anomalyQueries[i]?.data ?? []).filter(
      (f) => f.flagKey === flagKey,
    ).length;
  });
  const { refreshing, onRefresh } = usePullToRefresh(flagQuery.refetch);
  const flag = flagQuery.data;
  const envConfigs = flag ? orderEnvKeys(flag.envConfigs) : [];

  return (
    <ScreenView bottomInset testID="flag-detail-screen">
      <PageHeader
        title={flag?.name ?? flagKey ?? 'Flag'}
        left={<BackButton />}
        right={
          <PressableScale
            testID="flag-detail-ask-ai"
            onPress={() =>
              router.push(`/ai/create?flag=${encodeURIComponent(flagKey ?? '')}`)
            }
            hapticKind="light"
            accessibilityRole="button"
            accessibilityLabel="Describe a change for AI"
            style={{
              width: 34,
              height: 34,
              borderRadius: radius.sm,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: tokens.surface.raised,
              borderWidth: 1,
              borderColor: tokens.border.subtle,
            }}
          >
            <Feather name="message-square" size={16} color={tokens.text.primary} />
          </PressableScale>
        }
        testID="flag-detail-header"
      />
      <AsyncStateView
        testID="flag-detail-async"
        loading={contextLoading || flagQuery.isLoading}
        error={flagQuery.error}
        skeleton={<DetailSkeleton />}
        onRetry={() => flagQuery.refetch()}
      >
        <ScrollView
          testID="flag-detail-scroll"
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.xxl,
            gap: spacing.md,
          }}
          refreshControl={
            <RefreshControl
              refreshing={refreshing}
              onRefresh={onRefresh}
              tintColor={tokens.text.tertiary}
            />
          }
        >
          {flag ? (
            <>
              <View style={{ gap: spacing.sm }}>
                <MonoText testID="flag-detail-key">{flag.key}</MonoText>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  <Badge label={flag.kind === 'BOOLEAN' ? 'Boolean' : 'String'} tone="accent" />
                  {flag.tags.map((tag) => (
                    <Chip key={tag} label={tag} testID={`flag-detail-tag-${tag}`} />
                  ))}
                </View>
                {flag.description ? (
                  <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
                    {flag.description}
                  </Text>
                ) : null}
              </View>

              {envConfigs.map((envConfig) => (
                <EnvConfigCard
                  key={envConfig.envKey}
                  flag={flag}
                  envConfig={envConfig}
                  scope={{ userId, orgId, projectId }}
                  onEditTargeting={(envKey) =>
                    router.push(
                      `/flag/${encodeURIComponent(flag.key)}/targeting?env=${encodeURIComponent(envKey)}`,
                    )
                  }
                  onHistory={(envKey) =>
                    router.push(
                      `/flag/${encodeURIComponent(flag.key)}/history?env=${encodeURIComponent(envKey)}`,
                    )
                  }
                  onConflict={() => void flagQuery.refetch()}
                  openFindingCount={openFindingsByEnv[envConfig.envKey] ?? 0}
                  onMonitor={(envKey) =>
                    router.push(
                      `/flag/${encodeURIComponent(flag.key)}/monitor?env=${encodeURIComponent(envKey)}`,
                    )
                  }
                />
              ))}
            </>
          ) : null}
        </ScrollView>
      </AsyncStateView>
    </ScreenView>
  );
}
