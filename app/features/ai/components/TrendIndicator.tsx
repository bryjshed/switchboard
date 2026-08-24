import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Text, View } from 'react-native';

import { spacing, useTheme } from '@shared/theme';

import type { Trend } from '../lib/rolloutStats';

export interface TrendIndicatorProps {
  trend: Trend;
  label: string;
  /** For error rates, rising is bad; for conversion, rising is good. */
  risingIsBad?: boolean;
  testID?: string;
}

/** Arrow + label for a metric's direction over the window. */
export function TrendIndicator({
  trend,
  label,
  risingIsBad = true,
  testID,
}: TrendIndicatorProps) {
  const { tokens, typography } = useTheme();
  const good = trend === 'flat' ? null : (trend === 'up') !== risingIsBad;
  const color =
    good === null ? tokens.text.tertiary : good ? tokens.status.success : tokens.status.error;
  const icon = trend === 'up' ? 'trending-up' : trend === 'down' ? 'trending-down' : 'minus';
  return (
    <View testID={testID} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xxs }}>
      <Feather name={icon} size={12} color={color} />
      <Text style={[typography.caption, { color }]}>{label}</Text>
    </View>
  );
}
