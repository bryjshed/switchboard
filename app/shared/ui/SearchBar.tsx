import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import {
  Pressable,
  TextInput as RNTextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';

import { radius, spacing, useTheme } from '../theme';

export interface SearchBarProps {
  value: string;
  onChangeText: (text: string) => void;
  placeholder?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function SearchBar({
  value,
  onChangeText,
  placeholder = 'Search',
  style,
  testID,
}: SearchBarProps) {
  const { tokens, typography } = useTheme();
  return (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          backgroundColor: tokens.surface.subtle,
          borderRadius: radius.sm,
          borderWidth: 1,
          borderColor: tokens.border.subtle,
          paddingHorizontal: spacing.md,
          height: 40,
          gap: spacing.sm,
        },
        style,
      ]}
    >
      <Feather name="search" size={16} color={tokens.text.tertiary} />
      <RNTextInput
        testID={testID}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={tokens.text.tertiary}
        autoCapitalize="none"
        autoCorrect={false}
        returnKeyType="search"
        style={[typography.body, { flex: 1, color: tokens.text.primary, paddingVertical: 0 }]}
      />
      {value.length > 0 ? (
        <Pressable
          testID={testID ? `${testID}-clear` : undefined}
          accessibilityRole="button"
          accessibilityLabel="Clear search"
          onPress={() => onChangeText('')}
          hitSlop={8}
        >
          <Feather name="x-circle" size={16} color={tokens.text.tertiary} />
        </Pressable>
      ) : null}
    </View>
  );
}
