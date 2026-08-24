import { useRouter } from 'expo-router';
import React from 'react';
import { Text, View } from 'react-native';

import { spacing, useTheme } from '@shared/theme';
import { Button, MonoText, ScreenView } from '@shared/ui';

export default function WelcomeScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  return (
    <ScreenView bottomInset testID="welcome-screen">
      <View style={{ flex: 1, justifyContent: 'flex-end', padding: spacing.xl }}>
        <MonoText size="sm" color={tokens.accent.primaryDark}>
          switchboard
        </MonoText>
        <Text
          style={[typography.display, { color: tokens.text.primary, marginTop: spacing.sm }]}
        >
          Ship behind flags.{'\n'}Flip with confidence.
        </Text>
        <Text style={[typography.body, { color: tokens.text.secondary, marginTop: spacing.md }]}>
          Feature flags with an AI copilot: describe the rollout you want, review the diff, and
          watch it ramp.
        </Text>
        <Button
          testID="welcome-sign-in"
          label="Sign in"
          size="lg"
          onPress={() => router.push('/(auth)/login')}
          style={{ marginTop: spacing.xl }}
        />
      </View>
    </ScreenView>
  );
}
