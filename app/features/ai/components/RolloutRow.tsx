import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Text, View } from 'react-native';

import { spacing, useTheme } from '@shared/theme';
import { Badge, Card, MonoText, PressableScale } from '@shared/ui';
import type { RolloutStatsResponse } from '@shared/api/types';

import { assignVariantColors } from '../lib/variantPalette';
import {
  errorTrend,
  formatCount,
  formatRate,
  totalEvals,
  type ActiveRollout,
} from '../lib/rolloutStats';
import { SplitBar } from './SplitBar';
import { TrendIndicator } from './TrendIndicator';

export interface RolloutRowProps {
  rollout: ActiveRollout;
  /** Undefined until this flag's stats query resolves. */
  stats?: RolloutStatsResponse;
  onPress: () => void;
  /** True when an OPEN finding exists for this flag in this env. */
  hasOpenFinding?: boolean;
  testID?: string;
}

/**
 * One ramping flag. The split bar is the point: current traffic distribution at
 * a glance, per-variant colors from the token-derived palette rather than one
 * accent for everything. Eval counts and the error trend fill in as stats land,
 * so the row is useful before the second request finishes.
 */
export function RolloutRow({
  rollout,
  stats,
  onPress,
  hasOpenFinding = false,
  testID,
}: RolloutRowProps) {
  const { tokens, typography } = useTheme();
  const id = testID ?? `rollout-${rollout.flag.key}`;
  const totals = stats?.totals ?? [];
  const colors = assignVariantColors(
    tokens,
    totals.map((v) => v.variationId),
  );

  const segments =
    totals.length > 0
      ? totals.map((v) => ({
          key: v.variationId,
          weight: v.evalCount,
          color: colors[v.variationId],
        }))
      : [
          { key: 'on', weight: rollout.percentage, color: tokens.tints.dev.ink },
          { key: 'off', weight: 100 - rollout.percentage, color: tokens.text.tertiary },
        ];

  const evals = totalEvals(totals);
  const trend = errorTrend(stats);
  const worstError = totals.reduce((m, v) => Math.max(m, v.errorRate), 0);

  return (
    <PressableScale
      testID={id}
      onPress={onPress}
      hapticKind="selection"
      accessibilityRole="button"
      accessibilityLabel={`${rollout.flag.name} rollout, ${rollout.percentage} percent`}
    >
      <Card style={{ gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <View style={{ flex: 1, gap: spacing.xxs }}>
            <Text style={[typography.title, { color: tokens.text.primary }]} numberOfLines={1}>
              {rollout.flag.name}
            </Text>
            <MonoText size="sm" numberOfLines={1}>
              {rollout.flag.key}
            </MonoText>
          </View>
          {hasOpenFinding ? (
            <Badge testID={`${id}-finding`} label="Finding" tone="error" />
          ) : null}
          {rollout.killSwitchActive ? <Badge label="Killed" tone="error" /> : null}
          {!rollout.enabled ? <Badge label="Off" tone="neutral" /> : null}
          <Feather name="chevron-right" size={16} color={tokens.text.tertiary} />
        </View>

        <SplitBar testID={`${id}-split`} segments={segments} />

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <Text testID={`${id}-percent`} style={[typography.caption, { color: tokens.text.secondary }]}>
            {rollout.percentage}% ramped
          </Text>
          <Text testID={`${id}-evals`} style={[typography.caption, { color: tokens.text.tertiary }]}>
            {stats ? `${formatCount(evals)} evals` : 'loading evals'}
          </Text>
          <View style={{ flex: 1 }} />
          {stats ? (
            <TrendIndicator
              testID={`${id}-trend`}
              trend={trend}
              label={`${formatRate(worstError)} errors`}
            />
          ) : null}
        </View>
      </Card>
    </PressableScale>
  );
}
