import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import React from 'react';

import { radius, useTheme } from '../theme';
import { PressableScale } from './PressableScale';

export interface BackButtonProps {
  /** Where to land when there is no history (deep link into a detail screen). */
  fallbackHref?: string;
  testID?: string;
}

/** Header back affordance for pushed screens; falls back to a href when the
 * stack is empty (cold deep link) so the user is never stranded. */
export function BackButton({ fallbackHref = '/flags', testID = 'back' }: BackButtonProps) {
  const { tokens } = useTheme();
  const router = useRouter();
  return (
    <PressableScale
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel="Go back"
      hapticKind="selection"
      onPress={() => {
        if (router.canGoBack()) router.back();
        else router.replace(fallbackHref);
      }}
      style={{
        width: 34,
        height: 34,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tokens.surface.raised,
        borderWidth: 1,
        borderColor: tokens.border.subtle,
      }}
    >
      <Feather name="chevron-left" size={20} color={tokens.text.primary} />
    </PressableScale>
  );
}
