import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { useTheme } from '../theme';

export type StatusDotTone = 'success' | 'neutral' | 'error' | 'warning' | 'accent';

export interface StatusDotProps {
  tone: StatusDotTone;
  size?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Small solid state dot (flag on/off/killed, health indicators). */
export function StatusDot({ tone, size = 8, style, testID }: StatusDotProps) {
  const { tokens } = useTheme();
  const color = {
    success: tokens.status.success,
    neutral: tokens.text.tertiary,
    error: tokens.status.error,
    warning: tokens.status.warning,
    accent: tokens.accent.primary,
  }[tone];
  return (
    <View
      testID={testID}
      style={[{ width: size, height: size, borderRadius: size / 2, backgroundColor: color }, style]}
    />
  );
}
