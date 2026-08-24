import React from 'react';
import { Text, type StyleProp, type ViewStyle } from 'react-native';

import { radius, spacing, useTheme } from '../theme';
import { PressableScale } from './PressableScale';

export interface ChipProps {
  label: string;
  selected?: boolean;
  onPress?: () => void;
  disabled?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Pressable filter/tag chip. Selection is ink-inverted, not accent. */
export function Chip({ label, selected = false, onPress, disabled, style, testID }: ChipProps) {
  const { tokens, typography } = useTheme();
  return (
    <PressableScale
      testID={testID}
      onPress={onPress}
      disabled={disabled}
      hapticKind="selection"
      accessibilityRole="button"
      accessibilityState={{ selected, disabled: !!disabled }}
      style={[
        {
          backgroundColor: selected ? tokens.text.primary : tokens.surface.subtle,
          borderRadius: radius.pill,
          borderWidth: 1,
          borderColor: selected ? tokens.text.primary : tokens.border.subtle,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.xs + 2,
          opacity: disabled ? 0.5 : 1,
        },
        style,
      ]}
    >
      <Text style={[typography.label, { color: selected ? tokens.surface.base : tokens.text.secondary }]}>
        {label}
      </Text>
    </PressableScale>
  );
}
