import React from 'react';
import { Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { radius, spacing, useTheme } from '../theme';
import { haptic } from '../haptics';

export interface SegmentedControlProps<T extends string> {
  options: readonly { value: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Env-switcher style control. Selection is ink-inverted (primary ink pill,
 * inverted label) — deliberately NOT accent, which is reserved for CTAs.
 */
export function SegmentedControl<T extends string>({
  options,
  value,
  onChange,
  style,
  testID,
}: SegmentedControlProps<T>) {
  const { tokens, typography } = useTheme();
  return (
    <View
      testID={testID}
      accessibilityRole="tablist"
      style={[
        {
          flexDirection: 'row',
          backgroundColor: tokens.surface.subtle,
          borderRadius: radius.sm,
          borderWidth: 1,
          borderColor: tokens.border.subtle,
          padding: 3,
          gap: 2,
        },
        style,
      ]}
    >
      {options.map((opt) => {
        const selected = opt.value === value;
        return (
          <Pressable
            key={opt.value}
            testID={testID ? `${testID}-${opt.value}` : undefined}
            accessibilityRole="tab"
            accessibilityState={{ selected }}
            onPress={() => {
              if (!selected) {
                haptic('selection');
                onChange(opt.value);
              }
            }}
            style={{
              flex: 1,
              alignItems: 'center',
              paddingVertical: spacing.xs + 2,
              borderRadius: radius.sm - 3,
              backgroundColor: selected ? tokens.text.primary : 'transparent',
            }}
          >
            <Text
              style={[
                typography.label,
                { color: selected ? tokens.surface.base : tokens.text.secondary },
              ]}
            >
              {opt.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
