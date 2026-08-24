import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

import { radius, spacing, useTheme } from '../theme';
import { Button } from './Button';

export interface EmptyStateProps {
  icon?: React.ComponentProps<typeof Feather>['name'];
  title: string;
  message?: string;
  actionLabel?: string;
  onAction?: () => void;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

export function EmptyState({
  icon = 'inbox',
  title,
  message,
  actionLabel,
  onAction,
  style,
  testID,
}: EmptyStateProps) {
  const { tokens, typography } = useTheme();
  return (
    <View
      testID={testID}
      style={[{ alignItems: 'center', paddingVertical: spacing.xxxl, paddingHorizontal: spacing.xl }, style]}
    >
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: radius.pill,
          backgroundColor: tokens.surface.subtle,
          alignItems: 'center',
          justifyContent: 'center',
          marginBottom: spacing.md,
        }}
      >
        <Feather name={icon} size={20} color={tokens.text.tertiary} />
      </View>
      <Text style={[typography.title, { color: tokens.text.primary, textAlign: 'center' }]}>
        {title}
      </Text>
      {message ? (
        <Text
          style={[
            typography.bodySm,
            { color: tokens.text.secondary, textAlign: 'center', marginTop: spacing.xs },
          ]}
        >
          {message}
        </Text>
      ) : null}
      {actionLabel && onAction ? (
        <Button
          testID={testID ? `${testID}-action` : undefined}
          label={actionLabel}
          variant="secondary"
          size="sm"
          onPress={onAction}
          style={{ marginTop: spacing.lg }}
        />
      ) : null}
    </View>
  );
}
