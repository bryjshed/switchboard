import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { radius, useTheme } from '../theme';

export interface ProgressBarProps {
  /** 0..100 */
  value: number;
  height?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Thin determinate bar, accent fill on subtle track (rollout ramp %). */
export function ProgressBar({ value, height = 3, style, testID }: ProgressBarProps) {
  const { tokens } = useTheme();
  const clamped = Math.max(0, Math.min(100, value));
  return (
    <View
      testID={testID}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: clamped }}
      style={[
        {
          height,
          borderRadius: radius.pill,
          backgroundColor: tokens.surface.subtle,
          overflow: 'hidden',
        },
        style,
      ]}
    >
      <View
        style={{
          width: `${clamped}%`,
          height: '100%',
          borderRadius: radius.pill,
          backgroundColor: tokens.accent.primary,
        }}
      />
    </View>
  );
}
