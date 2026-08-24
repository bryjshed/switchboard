import React from 'react';
import { Modal, Text, View } from 'react-native';

import { radius, spacing, useTheme } from '../theme';
import { Button } from './Button';

export interface ConfirmDialogProps {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  loading?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** Optional body slot between the message and the buttons (e.g. a reason input). */
  children?: React.ReactNode;
  testID?: string;
}

/** Centered confirm dialog; destructive confirms use status.error. */
export function ConfirmDialog({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  destructive = false,
  loading = false,
  onConfirm,
  onCancel,
  children,
  testID,
}: ConfirmDialogProps) {
  const { tokens, typography } = useTheme();
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onCancel}>
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: tokens.surface.overlay,
          padding: spacing.xl,
        }}
      >
        <View
          testID={testID}
          style={[
            {
              width: '100%',
              maxWidth: 340,
              backgroundColor: tokens.surface.elevated,
              borderRadius: radius.md,
              padding: spacing.lg,
            },
            tokens.floatingShadow,
          ]}
        >
          <Text style={[typography.title, { color: tokens.text.primary }]}>{title}</Text>
          {message ? (
            <Text style={[typography.body, { color: tokens.text.secondary, marginTop: spacing.sm }]}>
              {message}
            </Text>
          ) : null}
          {children ? <View style={{ marginTop: spacing.md }}>{children}</View> : null}
          <View style={{ flexDirection: 'row', gap: spacing.sm, marginTop: spacing.lg }}>
            <Button
              testID={testID ? `${testID}-cancel` : undefined}
              label={cancelLabel}
              variant="secondary"
              onPress={onCancel}
              style={{ flex: 1 }}
            />
            <Button
              testID={testID ? `${testID}-confirm` : undefined}
              label={confirmLabel}
              variant={destructive ? 'destructive' : 'primary'}
              loading={loading}
              onPress={onConfirm}
              style={{ flex: 1 }}
            />
          </View>
        </View>
      </View>
    </Modal>
  );
}
