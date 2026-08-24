import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Text, View } from 'react-native';

import { radius, spacing, useTheme } from '@shared/theme';
import { MonoText, PressableScale } from '@shared/ui';
import type { AnomalyFindingResponse } from '@shared/api/types';

export interface AnomalyBannerProps {
  /** OPEN findings only. An empty array renders nothing at all. */
  findings: readonly AnomalyFindingResponse[];
  onPress: (finding: AnomalyFindingResponse) => void;
  testID?: string;
}

/**
 * Open-findings banner.
 *
 * Rendered only when something is actually wrong: no findings means no banner,
 * not an "all clear" empty state, so the surface never trains people to ignore
 * it. Tinted with status.errorBg rather than a solid red block, and it names
 * the flags in mono so the first glance already says WHICH flag.
 */
export function AnomalyBanner({ findings, onPress, testID = 'anomaly-banner' }: AnomalyBannerProps) {
  const { tokens, typography } = useTheme();
  if (findings.length === 0) return null;

  const first = findings[0];
  const keys = Array.from(new Set(findings.map((f) => f.flagKey)));
  const shown = keys.slice(0, 3);
  const extra = keys.length - shown.length;

  return (
    <PressableScale
      testID={testID}
      onPress={() => onPress(first)}
      hapticKind="warning"
      accessibilityRole="button"
      accessibilityLabel={`${findings.length} open anomaly findings. ${keys.join(', ')}`}
      style={{
        backgroundColor: tokens.status.errorBg,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: tokens.status.error,
        paddingHorizontal: spacing.md,
        paddingVertical: spacing.md,
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
      }}
    >
      <Feather name="alert-triangle" size={18} color={tokens.status.error} />
      <View style={{ flex: 1, gap: spacing.xxs }}>
        <Text testID={`${testID}-count`} style={[typography.subtitle, { color: tokens.status.error }]}>
          {findings.length === 1
            ? '1 rollout needs attention'
            : `${findings.length} rollouts need attention`}
        </Text>
        <MonoText testID={`${testID}-keys`} size="sm" color={tokens.status.error} numberOfLines={1}>
          {shown.join('  ')}
          {extra > 0 ? `  +${extra}` : ''}
        </MonoText>
      </View>
      <Feather name="chevron-right" size={16} color={tokens.status.error} />
    </PressableScale>
  );
}
