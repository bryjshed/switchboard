import React from 'react';
import { ActivityIndicator, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { radius, spacing, useTheme } from '../theme';
import { PressableScale } from './PressableScale';

export type ButtonVariant = 'primary' | 'secondary' | 'destructive';
export type ButtonSize = 'sm' | 'md' | 'lg';

export interface ButtonProps {
  label: string;
  onPress?: () => void;
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

const SIZES: Record<ButtonSize, { height: number; paddingHorizontal: number; fontSize: number }> = {
  sm: { height: 34, paddingHorizontal: spacing.md, fontSize: 13 },
  md: { height: 44, paddingHorizontal: spacing.lg, fontSize: 15 },
  lg: { height: 52, paddingHorizontal: spacing.xl, fontSize: 16 },
};

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  loading = false,
  disabled = false,
  style,
  testID,
}: ButtonProps) {
  const { tokens, typography } = useTheme();
  const dims = SIZES[size];
  const colors = (() => {
    switch (variant) {
      case 'secondary':
        return {
          bg: tokens.surface.raised,
          ink: tokens.text.primary,
          border: tokens.border.default,
        };
      case 'destructive':
        return { bg: tokens.status.error, ink: tokens.text.onAccent, border: 'transparent' };
      default:
        return { bg: tokens.accent.primary, ink: tokens.text.onAccent, border: 'transparent' };
    }
  })();
  const blocked = disabled || loading;

  return (
    <PressableScale
      testID={testID}
      onPress={blocked ? undefined : onPress}
      disabled={blocked}
      hapticKind="light"
      accessibilityRole="button"
      accessibilityState={{ disabled: blocked, busy: loading }}
      style={[
        {
          height: dims.height,
          paddingHorizontal: dims.paddingHorizontal,
          borderRadius: radius.sm,
          backgroundColor: colors.bg,
          borderWidth: variant === 'secondary' ? 1 : 0,
          borderColor: colors.border,
          alignItems: 'center',
          justifyContent: 'center',
          flexDirection: 'row',
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={colors.ink} />
      ) : (
        <View>
          <Text
            style={[
              typography.title,
              { fontSize: dims.fontSize, lineHeight: dims.fontSize + 5, color: colors.ink },
            ]}
          >
            {label}
          </Text>
        </View>
      )}
    </PressableScale>
  );
}
