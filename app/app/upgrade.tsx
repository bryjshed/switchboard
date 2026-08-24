import { useRouter } from 'expo-router';
import React from 'react';
import { Text, View } from 'react-native';

import { spacing, useTheme } from '@shared/theme';
import { Badge, Button, ScreenView } from '@shared/ui';

/**
 * Static upsell placeholder. CapExceededError (UPGRADE_REQUIRED) routes here
 * once billing lands; A1 only reserves the route + seam.
 */
export default function UpgradeScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  return (
    <ScreenView topInset={false} bottomInset testID="upgrade-screen">
      <View style={{ flex: 1, justifyContent: 'center', padding: spacing.xl, gap: spacing.md }}>
        <Badge label="Plan limit" tone="accent" />
        <Text style={[typography.headline, { color: tokens.text.primary }]}>
          You have outgrown the free plan
        </Text>
        <Text style={[typography.body, { color: tokens.text.secondary }]}>
          Upgrade to keep creating flags, environments, and AI proposals for your team. Billing
          arrives in a later release; this screen is a placeholder.
        </Text>
        <Button label="Close" variant="secondary" onPress={() => router.back()} />
      </View>
    </ScreenView>
  );
}
