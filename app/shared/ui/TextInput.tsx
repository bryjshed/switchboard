import React, { useState } from 'react';
import {
  Text,
  TextInput as RNTextInput,
  View,
  type StyleProp,
  type TextInputProps as RNTextInputProps,
  type ViewStyle,
} from 'react-native';

import { radius, spacing, useTheme } from '../theme';

export interface TextInputProps extends Omit<RNTextInputProps, 'style'> {
  label?: string;
  error?: string;
  /** Use the mono slot (flag keys, context keys). */
  mono?: boolean;
  containerStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

export function TextInput({
  label,
  error,
  mono = false,
  containerStyle,
  testID,
  onFocus,
  onBlur,
  ...rest
}: TextInputProps) {
  const { tokens, typography } = useTheme();
  const [focused, setFocused] = useState(false);
  const borderColor = error
    ? tokens.status.error
    : focused
      ? tokens.border.strong
      : tokens.border.default;

  return (
    <View style={containerStyle}>
      {label ? (
        <Text style={[typography.label, { color: tokens.text.secondary, marginBottom: spacing.xs }]}>
          {label}
        </Text>
      ) : null}
      <RNTextInput
        testID={testID}
        {...rest}
        onFocus={(e) => {
          setFocused(true);
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setFocused(false);
          onBlur?.(e);
        }}
        placeholderTextColor={tokens.text.tertiary}
        style={[
          mono ? typography.mono : typography.body,
          {
            color: tokens.text.primary,
            backgroundColor: tokens.surface.raised,
            borderWidth: 1,
            borderColor,
            borderRadius: radius.sm,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.md,
            minHeight: 44,
          },
        ]}
      />
      {error ? (
        <Text style={[typography.caption, { color: tokens.status.error, marginTop: spacing.xs }]}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
