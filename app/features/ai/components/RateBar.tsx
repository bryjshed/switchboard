import React from 'react';
import { View } from 'react-native';

import { radius, useTheme } from '@shared/theme';

export interface RateBarProps {
  /** 0..1 fraction. */
  value: number;
  /** Largest value in the comparison group, so bars share one scale. */
  max?: number;
  color: string;
  height?: number;
  testID?: string;
}

/**
 * One rate as a horizontal bar. Bars in a group share `max` so a 20% error rate
 * next to a 2% one reads as ten times longer, not "both near full".
 */
export function RateBar({ value, max = 1, color, height = 6, testID }: RateBarProps) {
  const { tokens } = useTheme();
  const safeMax = max > 0 ? max : 1;
  const pct = Math.max(0, Math.min(100, (value / safeMax) * 100));
  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(pct) }}
      style={{
        height,
        borderRadius: radius.pill,
        backgroundColor: tokens.surface.subtle,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          width: `${pct === 0 && value > 0 ? 2 : pct}%`,
          minWidth: value > 0 ? 3 : 0,
          height: '100%',
          borderRadius: radius.pill,
          backgroundColor: color,
        }}
      />
    </View>
  );
}
