import Feather from '@expo/vector-icons/Feather';
import { useQuery } from '@tanstack/react-query';
import * as Clipboard from 'expo-clipboard';
import React, { useMemo, useState } from 'react';
import { FlatList, ScrollView, Text, View } from 'react-native';

import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import {
  useCreateSdkKeyMutation,
  useRevokeSdkKeyMutation,
} from '@features/sdkKeys/mutations/sdkKeyMutations';
import { sdkKeysOptions } from '@features/sdkKeys/queries/sdkKeyQueries';
import { haptic } from '@shared/haptics';
import { envLabel } from '@shared/lib/env';
import { dateTimeLabel } from '@shared/lib/time';
import { radius, spacing, useTheme } from '@shared/theme';
import {
  AsyncStateView,
  BackButton,
  Badge,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  MonoText,
  PageHeader,
  PressableScale,
  ScreenView,
  Sheet,
  Skeleton,
  TextInput,
} from '@shared/ui';
import type { SdkKeyResponse } from '@shared/api/types';

export default function SdkKeysScreen() {
  const { tokens, typography } = useTheme();
  const { userId, orgId, environments, envKey, loading: contextLoading } = useActiveContext();
  const [selectedEnvKey, setSelectedEnvKey] = useState<string | undefined>(undefined);

  const activeKey = selectedEnvKey ?? envKey;
  const env = useMemo(
    () => environments.find((e) => e.key === activeKey) ?? environments[0],
    [environments, activeKey],
  );

  const keysQuery = useQuery(sdkKeysOptions(userId, env?.id));
  const scope = { userId, orgId, envId: env?.id };
  const createKey = useCreateSdkKeyMutation(scope);
  const revokeKey = useRevokeSdkKeyMutation(scope);

  const [createVisible, setCreateVisible] = useState(false);
  const [label, setLabel] = useState('');
  const [revealed, setRevealed] = useState<{ key: string; label?: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<SdkKeyResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const submitCreate = async () => {
    if (!env || createKey.isPending) return;
    setError(null);
    try {
      const created = await createKey.mutateAsync(label);
      setCreateVisible(false);
      setLabel('');
      setCopied(false);
      setRevealed({ key: created.key, label: created.label });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the key');
    }
  };

  const copy = async () => {
    if (!revealed) return;
    await Clipboard.setStringAsync(revealed.key);
    haptic('success');
    setCopied(true);
  };

  const confirmRevoke = async () => {
    const target = revoking;
    setRevoking(null);
    if (!target) return;
    setError(null);
    try {
      await revokeKey.mutateAsync(target.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not revoke the key');
    }
  };

  const keys = keysQuery.data ?? [];

  return (
    <ScreenView bottomInset testID="sdk-keys-screen">
      <PageHeader
        title="SDK keys"
        subtitle={env ? envLabel(env.key) : undefined}
        left={<BackButton fallbackHref="/settings" />}
        right={
          <Button
            testID="sdk-keys-create"
            label="New key"
            size="sm"
            disabled={!env}
            onPress={() => setCreateVisible(true)}
          />
        }
      />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.md }}>
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            {environments.map((e) => (
              <Chip
                key={e.id}
                testID={`sdk-keys-env-${e.key}`}
                label={envLabel(e.key)}
                selected={e.id === env?.id}
                onPress={() => setSelectedEnvKey(e.key)}
              />
            ))}
          </View>
        </ScrollView>
      </View>

      {error ? (
        <Text
          testID="sdk-keys-error"
          style={[
            typography.bodySm,
            { color: tokens.status.error, paddingHorizontal: spacing.lg, paddingBottom: spacing.sm },
          ]}
        >
          {error}
        </Text>
      ) : null}

      <AsyncStateView
        testID="sdk-keys-async"
        loading={contextLoading || keysQuery.isLoading}
        error={keysQuery.error}
        empty={keys.length === 0}
        skeleton={
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={72} radius={14} />
            ))}
          </View>
        }
        emptyState={
          <EmptyState
            testID="sdk-keys-empty"
            icon="key"
            title="No keys for this environment"
            message="Create one to let an SDK evaluate flags here. The full key is shown once."
            actionLabel="New key"
            onAction={() => setCreateVisible(true)}
          />
        }
        onRetry={() => keysQuery.refetch()}
      >
        <FlatList
          testID="sdk-keys-list"
          data={keys}
          keyExtractor={(item) => item.id}
          contentContainerStyle={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.xxl }}
          renderItem={({ item }) => {
            const revoked = !!item.revokedAt;
            return (
              <Card
                testID={`sdk-key-${item.id}`}
                style={{ marginBottom: spacing.md, gap: spacing.sm, opacity: revoked ? 0.55 : 1 }}
              >
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <MonoText color={tokens.text.primary} style={{ flex: 1 }} numberOfLines={1}>
                    {item.keyPrefix}
                  </MonoText>
                  {revoked ? <Badge label="Revoked" tone="error" /> : null}
                </View>
                <Text style={[typography.caption, { color: tokens.text.tertiary }]}>
                  {item.label ? `${item.label} · ` : ''}
                  created {dateTimeLabel(item.createdAt)}
                </Text>
                {!revoked ? (
                  <Button
                    testID={`sdk-key-${item.id}-revoke`}
                    label="Revoke"
                    variant="secondary"
                    size="sm"
                    onPress={() => setRevoking(item)}
                  />
                ) : null}
              </Card>
            );
          }}
        />
      </AsyncStateView>

      <Sheet
        visible={createVisible}
        onClose={() => setCreateVisible(false)}
        title="New SDK key"
        testID="sdk-keys-create-sheet"
      >
        <View style={{ gap: spacing.md }}>
          <TextInput
            testID="sdk-keys-label"
            label="Label (optional)"
            value={label}
            onChangeText={setLabel}
            placeholder="iOS release build"
          />
          <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
            The full key is shown once, right after it is created. Store it somewhere safe.
          </Text>
          <Button
            testID="sdk-keys-create-submit"
            label="Create key"
            loading={createKey.isPending}
            onPress={() => void submitCreate()}
          />
        </View>
      </Sheet>

      <Sheet
        visible={!!revealed}
        onClose={() => setRevealed(null)}
        title="Copy your key now"
        testID="sdk-keys-reveal"
      >
        <View style={{ gap: spacing.md }}>
          <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
            This is the only time the full key is shown.
          </Text>
          <PressableScale
            testID="sdk-keys-reveal-copy"
            onPress={() => void copy()}
            hapticKind="light"
            accessibilityRole="button"
            accessibilityLabel="Copy SDK key"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.sm,
              padding: spacing.md,
              borderRadius: radius.sm,
              backgroundColor: tokens.surface.subtle,
              borderWidth: 1,
              borderColor: tokens.border.default,
            }}
          >
            <MonoText size="sm" color={tokens.text.primary} style={{ flex: 1 }}>
              {revealed?.key ?? ''}
            </MonoText>
            <Feather
              name={copied ? 'check' : 'copy'}
              size={16}
              color={copied ? tokens.status.success : tokens.text.secondary}
            />
          </PressableScale>
          <Button
            testID="sdk-keys-reveal-done"
            label={copied ? 'Done' : 'I have copied it'}
            onPress={() => setRevealed(null)}
          />
        </View>
      </Sheet>

      <ConfirmDialog
        testID="sdk-keys-revoke-confirm"
        visible={!!revoking}
        title="Revoke this key?"
        message={`Any SDK using ${revoking?.keyPrefix ?? 'this key'} stops evaluating immediately.`}
        confirmLabel="Revoke"
        destructive
        loading={revokeKey.isPending}
        onCancel={() => setRevoking(null)}
        onConfirm={() => void confirmRevoke()}
      />
    </ScreenView>
  );
}
