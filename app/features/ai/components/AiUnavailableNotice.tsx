import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Text, View } from 'react-native';

import { radius, spacing, useTheme } from '@shared/theme';
import { Card, MonoText } from '@shared/ui';

export interface AiUnavailableNoticeProps {
  testID?: string;
}

/**
 * The 503 AI_UNAVAILABLE surface.
 *
 * This is what a local stack shows by default, so it is written as an
 * explanation with the fix in it, not as an error. Neutral surface, no red, no
 * toast: nothing is broken, a key is simply not set.
 */
export function AiUnavailableNotice({ testID = 'ai-unavailable' }: AiUnavailableNoticeProps) {
  const { tokens, typography } = useTheme();
  return (
    <Card testID={testID} style={{ gap: spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <View
          style={{
            width: 32,
            height: 32,
            borderRadius: radius.pill,
            backgroundColor: tokens.surface.subtle,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Feather name="key" size={16} color={tokens.text.tertiary} />
        </View>
        <Text style={[typography.title, { color: tokens.text.primary, flex: 1 }]}>
          AI drafting is not configured
        </Text>
      </View>
      <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
        Turning a prompt into a flag change needs an Anthropic API key on the Switchboard server.
        Set it and restart the backend:
      </Text>
      <View
        style={{
          backgroundColor: tokens.surface.subtle,
          borderRadius: radius.sm,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
        }}
      >
        <MonoText testID={`${testID}-env`} size="sm" color={tokens.text.primary}>
          ANTHROPIC_API_KEY=sk-ant-...
        </MonoText>
      </View>
      <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
        Everything else keeps working. Rollout monitoring, healing, and optimizing run on the
        metrics pipeline, so anomaly findings and their suggested proposals still arrive without a
        key.
      </Text>
    </Card>
  );
}
