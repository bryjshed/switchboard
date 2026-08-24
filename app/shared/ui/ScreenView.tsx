import React from 'react';
import { View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useTheme } from '../theme';

export interface ScreenViewProps {
  children: React.ReactNode;
  /** Apply top inset (screens without a native header). */
  topInset?: boolean;
  /** Apply bottom inset (screens outside the tab bar). */
  bottomInset?: boolean;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Screen root: surface.base background + safe-area handling. */
export function ScreenView({
  children,
  topInset = true,
  bottomInset = false,
  style,
  testID,
}: ScreenViewProps) {
  const { tokens } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      testID={testID}
      style={[
        {
          flex: 1,
          backgroundColor: tokens.surface.base,
          paddingTop: topInset ? insets.top : 0,
          paddingBottom: bottomInset ? insets.bottom : 0,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
