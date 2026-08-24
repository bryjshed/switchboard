import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useEffect, useMemo, useReducer, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';

import Feather from '@expo/vector-icons/Feather';

import { RuleEditor } from '@features/flags/components/targeting/RuleEditor';
import { ServeEditor } from '@features/flags/components/targeting/ServeEditor';
import { VariationPicker } from '@features/flags/components/targeting/VariationPicker';
import {
  isDirty,
  targetingError,
  targetingReducer,
  type TargetingDraft,
} from '@features/flags/lib/targetingReducer';
import { useEnvConfigMutation } from '@features/flags/mutations/flagMutations';
import { flagDetailOptions } from '@features/flags/queries/flagQueries';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { ApiClientError } from '@shared/api/client';
import { envLabel } from '@shared/lib/env';
import { spacing, useTheme } from '@shared/theme';
import {
  AsyncStateView,
  BackButton,
  Badge,
  Button,
  Card,
  PageHeader,
  ScreenView,
  Skeleton,
  TextInput,
} from '@shared/ui';

const EMPTY_DRAFT: TargetingDraft = {
  enabled: false,
  config: { fallthrough: {}, offVariationId: '', defaultVariationId: '' },
};

export default function TargetingScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ flagKey: string; env?: string }>();
  const flagKey = params.flagKey;
  const {
    userId,
    orgId,
    projectId,
    envKey: activeEnvKey,
    loading: contextLoading,
  } = useActiveContext();
  const envKey = params.env ?? activeEnvKey;

  const flagQuery = useQuery(flagDetailOptions(userId, projectId, flagKey));
  const envWrite = useEnvConfigMutation({ userId, orgId, projectId });

  const envConfig = useMemo(
    () => flagQuery.data?.envConfigs.find((e) => e.envKey === envKey),
    [flagQuery.data, envKey],
  );

  const original: TargetingDraft = useMemo(
    () =>
      envConfig ? { enabled: envConfig.enabled, config: envConfig.config } : EMPTY_DRAFT,
    [envConfig],
  );

  const [draft, dispatch] = useReducer(targetingReducer, EMPTY_DRAFT);
  const [message, setMessage] = useState<string | null>(null);

  // Re-seed whenever the loaded version changes (first load, or a refetch after
  // a 409) so the editor never edits a stale snapshot.
  useEffect(() => {
    if (envConfig) dispatch({ type: 'reset', draft: { enabled: envConfig.enabled, config: envConfig.config } });
  }, [envConfig]);

  const flag = flagQuery.data;
  const variations = flag?.variations ?? [];
  const error = targetingError(draft);
  const dirty = isDirty(draft, original);
  const canSave = !error && dirty && !!envConfig && !envWrite.isPending;

  const save = async () => {
    if (!canSave || !envConfig || !flag) return;
    setMessage(null);
    try {
      await envWrite.mutateAsync({
        flagKey: flag.key,
        envKey: envConfig.envKey,
        enabled: draft.enabled,
        config: draft.config,
        expectedVersion: envConfig.version,
        comment: 'targeting update',
      });
      router.back();
    } catch (e) {
      if (e instanceof ApiClientError && e.status === 409) {
        setMessage('Config changed elsewhere — refreshed');
        void flagQuery.refetch();
        return;
      }
      setMessage(e instanceof Error ? e.message : 'Save failed');
    }
  };

  return (
    <ScreenView bottomInset testID="targeting-screen">
      <PageHeader
        title="Targeting"
        subtitle={flagKey ? `${flagKey} · ${envKey ? envLabel(envKey) : ''}` : undefined}
        left={<BackButton />}
        right={envKey ? <Badge label={envLabel(envKey)} tone="neutral" /> : undefined}
      />
      <AsyncStateView
        testID="targeting-async"
        loading={contextLoading || flagQuery.isLoading}
        error={flagQuery.error}
        empty={!contextLoading && !flagQuery.isLoading && !envConfig}
        skeleton={
          <View style={{ paddingHorizontal: spacing.lg, gap: spacing.md }}>
            {[0, 1, 2].map((i) => (
              <Skeleton key={i} height={120} radius={14} />
            ))}
          </View>
        }
        onRetry={() => flagQuery.refetch()}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={{ flex: 1 }}
        >
          <ScrollView
            testID="targeting-scroll"
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{
              paddingHorizontal: spacing.lg,
              paddingBottom: spacing.xxl,
              gap: spacing.md,
            }}
          >
            <Card style={{ gap: spacing.md }}>
              <Text style={[typography.label, { color: tokens.text.secondary }]}>
                INDIVIDUAL TARGETS
              </Text>
              {(draft.config.individualTargets ?? []).length === 0 ? (
                <Text style={[typography.bodySm, { color: tokens.text.tertiary }]}>
                  No individual targets. Targets win over every rule.
                </Text>
              ) : null}
              {(draft.config.individualTargets ?? []).map((target, index) => (
                <View key={index} style={{ gap: spacing.sm }}>
                  <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm }}>
                    <TextInput
                      testID={`target-${index}-key`}
                      containerStyle={{ flex: 1 }}
                      label={`Context key ${index + 1}`}
                      value={target.contextKey}
                      mono
                      autoCapitalize="none"
                      autoCorrect={false}
                      placeholder="user-1"
                      onChangeText={(contextKey) =>
                        dispatch({ type: 'updateTarget', index, patch: { contextKey } })
                      }
                    />
                    <Pressable
                      testID={`target-${index}-remove`}
                      accessibilityRole="button"
                      accessibilityLabel={`Remove target ${index + 1}`}
                      hitSlop={8}
                      onPress={() => dispatch({ type: 'removeTarget', index })}
                      style={{ height: 44, justifyContent: 'center' }}
                    >
                      <Feather name="minus-circle" size={18} color={tokens.text.tertiary} />
                    </Pressable>
                  </View>
                  <VariationPicker
                    testID={`target-${index}-variation`}
                    variations={variations}
                    value={target.variationId}
                    onChange={(variationId) =>
                      dispatch({ type: 'updateTarget', index, patch: { variationId } })
                    }
                  />
                </View>
              ))}
              <Button
                testID="target-add"
                label="Add target"
                variant="secondary"
                size="sm"
                onPress={() => dispatch({ type: 'addTarget' })}
              />
            </Card>

            <Text style={[typography.label, { color: tokens.text.secondary }]}>RULES</Text>
            {(draft.config.rules ?? []).map((rule, index) => (
              <RuleEditor
                key={rule.id}
                rule={rule}
                index={index}
                variations={variations}
                onUpdateClause={(clauseIndex, patch) =>
                  dispatch({ type: 'updateClause', ruleId: rule.id, index: clauseIndex, patch })
                }
                onAddClause={() => dispatch({ type: 'addClause', ruleId: rule.id })}
                onRemoveClause={(clauseIndex) =>
                  dispatch({ type: 'removeClause', ruleId: rule.id, index: clauseIndex })
                }
                onServeChange={(serve) =>
                  dispatch({ type: 'updateRule', ruleId: rule.id, patch: { serve } })
                }
                onRemove={() => dispatch({ type: 'removeRule', ruleId: rule.id })}
              />
            ))}
            <Button
              testID="rule-add"
              label="Add rule"
              variant="secondary"
              size="sm"
              onPress={() => dispatch({ type: 'addRule' })}
            />

            <Card style={{ gap: spacing.lg }}>
              <ServeEditor
                testID="fallthrough"
                label="FALLTHROUGH"
                variations={variations}
                serve={draft.config.fallthrough}
                onChange={(serve) => dispatch({ type: 'setFallthrough', serve })}
              />
              <View style={{ gap: spacing.sm }}>
                <Text style={[typography.label, { color: tokens.text.secondary }]}>
                  OFF VARIATION
                </Text>
                <VariationPicker
                  testID="off-variation"
                  variations={variations}
                  value={draft.config.offVariationId}
                  onChange={(variationId) => dispatch({ type: 'setOffVariation', variationId })}
                />
              </View>
              <View style={{ gap: spacing.sm }}>
                <Text style={[typography.label, { color: tokens.text.secondary }]}>
                  DEFAULT VARIATION
                </Text>
                <VariationPicker
                  testID="default-variation"
                  variations={variations}
                  value={draft.config.defaultVariationId}
                  onChange={(variationId) => dispatch({ type: 'setDefaultVariation', variationId })}
                />
              </View>
            </Card>

            {error || message ? (
              <Text
                testID="targeting-message"
                style={[typography.bodySm, { color: message ? tokens.status.error : tokens.text.tertiary }]}
              >
                {message ?? error}
              </Text>
            ) : null}

            <Button
              testID="targeting-save"
              label={dirty ? 'Save targeting' : 'No changes'}
              disabled={!canSave}
              loading={envWrite.isPending}
              onPress={() => void save()}
            />
          </ScrollView>
        </KeyboardAvoidingView>
      </AsyncStateView>
    </ScreenView>
  );
}
