import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { radius, spacing, useTheme } from '../theme';

export type BadgeTone = 'neutral' | 'accent' | 'success' | 'warning' | 'error' | 'dev' | 'staging' | 'production';

export interface BadgeProps {
  label: string;
  tone?: BadgeTone;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Static tinted label (env identities, statuses). Not pressable. */
export function Badge({ label, tone = 'neutral', style, testID }: BadgeProps) {
  const { tokens, typography } = useTheme();
  const pair = (() => {
    switch (tone) {
      case 'accent':
        return { bg: tokens.accent.subtle, ink: tokens.accent.primaryDark };
      case 'success':
        return { bg: tokens.status.successBg, ink: tokens.status.success };
      case 'warning':
        return { bg: tokens.status.warningBg, ink: tokens.status.warning };
      case 'error':
        return { bg: tokens.status.errorBg, ink: tokens.status.error };
      case 'dev':
        return tokens.tints.dev;
      case 'staging':
        return tokens.tints.staging;
      case 'production':
        return tokens.tints.production;
      default:
        return { bg: tokens.surface.subtle, ink: tokens.text.secondary };
    }
  })();
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: pair.bg,
          borderRadius: radius.pill,
          paddingHorizontal: spacing.sm,
          paddingVertical: spacing.xxs,
          alignSelf: 'flex-start',
        },
        style,
      ]}
    >
      <Text style={[typography.label, { color: pair.ink }]}>{label}</Text>
    </View>
  );
}
