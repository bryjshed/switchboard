import React from 'react';
import { Modal, Pressable, Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { radius, spacing, useTheme } from '../theme';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  testID?: string;
}

/** Modal bottom sheet: overlay scrim, raised surface, radius.lg top corners. */
export function Sheet({ visible, onClose, title, children, contentStyle, testID }: SheetProps) {
  const { tokens, typography } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: tokens.surface.overlay }}>
        <Pressable
          testID={testID ? `${testID}-backdrop` : undefined}
          accessibilityLabel="Close sheet"
          style={{ flex: 1 }}
          onPress={onClose}
        />
        <View
          testID={testID}
          style={[
            {
              backgroundColor: tokens.surface.raised,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              paddingHorizontal: spacing.lg,
              paddingTop: spacing.md,
              paddingBottom: Math.max(insets.bottom, spacing.lg),
            },
            contentStyle,
          ]}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 36,
              height: 4,
              borderRadius: radius.pill,
              backgroundColor: tokens.border.strong,
              marginBottom: spacing.md,
            }}
          />
          {title ? (
            <Text
              style={[typography.title, { color: tokens.text.primary, marginBottom: spacing.md }]}
            >
              {title}
            </Text>
          ) : null}
          {children}
        </View>
      </View>
    </Modal>
  );
}
