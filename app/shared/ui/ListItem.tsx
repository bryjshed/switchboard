import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { spacing, useTheme } from '../theme';
import { PressableScale } from './PressableScale';

export interface ListItemProps {
  title: string;
  subtitle?: string;
  left?: React.ReactNode;
  right?: React.ReactNode;
  chevron?: boolean;
  onPress?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Dense settings/menu row with hairline separator discipline handled by lists. */
export function ListItem({
  title,
  subtitle,
  left,
  right,
  chevron = false,
  onPress,
  style,
  testID,
}: ListItemProps) {
  const { tokens, typography } = useTheme();
  const content = (
    <View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: spacing.md,
          paddingHorizontal: spacing.lg,
          gap: spacing.md,
          minHeight: 52,
        },
        style,
      ]}
    >
      {left}
      <View style={{ flex: 1 }}>
        <Text style={[typography.subtitle, { color: tokens.text.primary }]}>{title}</Text>
        {subtitle ? (
          <Text style={[typography.bodySm, { color: tokens.text.secondary, marginTop: 1 }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
      {chevron ? <Feather name="chevron-right" size={16} color={tokens.text.tertiary} /> : null}
    </View>
  );
  if (!onPress) {
    return <View testID={testID}>{content}</View>;
  }
  return (
    <PressableScale testID={testID} onPress={onPress} accessibilityRole="button">
      {content}
    </PressableScale>
  );
}
