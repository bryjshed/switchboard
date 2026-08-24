import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';

import { radius, spacing, useTheme } from '../theme';

export interface CardProps {
  children: React.ReactNode;
  /** raised (default) sits on base; elevated adds the floating shadow tier. */
  variant?: 'raised' | 'elevated';
  padded?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Surface container with hairline border; the app's row/panel foundation. */
export function Card({ children, variant = 'raised', padded = true, style, testID }: CardProps) {
  const { tokens } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          backgroundColor: variant === 'elevated' ? tokens.surface.elevated : tokens.surface.raised,
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: tokens.border.subtle,
          padding: padded ? spacing.lg : 0,
        },
        variant === 'elevated' ? tokens.floatingShadow : null,
        style,
      ]}
    >
      {children}
    </View>
  );
}
