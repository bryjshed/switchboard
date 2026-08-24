import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { spacing, useTheme } from '../theme';

export interface PageHeaderProps {
  title: string;
  subtitle?: string;
  /** Left-aligned accessory (e.g. a back button on pushed screens). */
  left?: React.ReactNode;
  /** Right-aligned accessory (e.g. an action button). */
  right?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Screen header. Title is the sanctioned display-font slot. */
export function PageHeader({ title, subtitle, left, right, style, testID }: PageHeaderProps) {
  const { tokens, typography } = useTheme();
  return (
    <View
      testID={testID}
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.md,
          paddingBottom: spacing.md,
          gap: spacing.md,
        },
        style,
      ]}
    >
      {left}
      <View style={{ flex: 1 }}>
        <Text style={[typography.pageTitle, { color: tokens.text.primary }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={[typography.bodySm, { color: tokens.text.secondary, marginTop: spacing.xxs }]}>
            {subtitle}
          </Text>
        ) : null}
      </View>
      {right}
    </View>
  );
}
