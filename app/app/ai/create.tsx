import Feather from '@expo/vector-icons/Feather';
import { useQuery } from '@tanstack/react-query';
import { useLocalSearchParams, useRouter } from 'expo-router';
import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, ScrollView, Text, View } from 'react-native';

import { AiUnavailableNotice } from '@features/ai/components/AiUnavailableNotice';
import { DiffPreview } from '@features/ai/components/DiffPreview';
import { isAiUnavailable, isConflict } from '@features/ai/lib/aiErrors';
import {
  useApplyProposalMutation,
  useDraftProposalMutation,
} from '@features/ai/mutations/aiMutations';
import { flagDetailOptions } from '@features/flags/queries/flagQueries';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { orgSettingsOptions } from '@features/orgs/queries/orgQueries';
import { envLabel } from '@shared/lib/env';
import { radius, spacing, useTheme } from '@shared/theme';
import type { AiProposalResponse } from '@shared/api/types';
import {
  Button,
  Card,
  Chip,
  EmptyState,
  MonoText,
  PageHeader,
  PressableScale,
  ScreenView,
  SegmentedControl,
  Skeleton,
  TextInput,
} from '@shared/ui';

const EXAMPLE_PROMPTS = [
  'Release the new planner to 10% of iOS users on Pro',
  'Kill the payments experiment in production',
  'Turn dark mode fully on in dev',
];

const ANY_ENV = 'any';
const MAX_PROMPT = 2000;

/**
 * Natural language → reviewable change.
 *
 * Two states in one modal: write a prompt, then review what came back. The
 * proposal is NEVER applied straight from the prompt — the DiffPreview between
 * them is the whole point, and Apply is only reachable after it renders.
 */
export default function AiCreateScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  const { flag: flagParam, env: envParam } = useLocalSearchParams<{ flag?: string; env?: string }>();
  const { userId, orgId, projectId, environments, envKey: activeEnvKey } = useActiveContext();

  const [prompt, setPrompt] = useState('');
  const [envChoice, setEnvChoice] = useState<string>(envParam || activeEnvKey || ANY_ENV);
  const [proposal, setProposal] = useState<AiProposalResponse | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const scope = { userId, orgId, projectId };
  const draft = useDraftProposalMutation(scope);
  const apply = useApplyProposalMutation(scope);

  const settingsQuery = useQuery(orgSettingsOptions(userId, orgId));
  // Context flag: fetched both to show "about this flag" and to give DiffPreview
  // the current values for its before → after side.
  const contextFlagKey = flagParam || proposal?.diff.flagKey;
  const flagQuery = useQuery(flagDetailOptions(userId, projectId, contextFlagKey));

  const aiDisabledByOrg = settingsQuery.data?.aiEnabled === false;
  const unavailable = isAiUnavailable(draft.error) || aiDisabledByOrg;

  const envOptions = useMemo(
    () => [
      { value: ANY_ENV, label: 'Any' },
      ...environments.map((e) => ({ value: e.key, label: envLabel(e.key) })),
    ],
    [environments],
  );

  const trimmed = prompt.trim();
  const canSubmit =
    !!projectId && trimmed.length > 0 && trimmed.length <= MAX_PROMPT && !unavailable;

  const onSubmit = async () => {
    setMessage(null);
    try {
      const result = await draft.mutateAsync({
        prompt: trimmed,
        environmentKey: envChoice === ANY_ENV ? undefined : envChoice,
        flagKey: flagParam || undefined,
      });
      setProposal(result);
    } catch (e) {
      // 503 renders as the explanatory panel below, not as an error message.
      if (isAiUnavailable(e)) return;
      setMessage(e instanceof Error ? e.message : 'Could not draft a change');
    }
  };

  const onApply = async () => {
    if (!proposal) return;
    setMessage(null);
    try {
      const applied = await apply.mutateAsync({
        proposalId: proposal.id,
        reason: 'Applied from mobile',
      });
      router.replace(`/flag/${encodeURIComponent(applied.diff.flagKey)}`);
    } catch (e) {
      if (isConflict(e)) {
        setMessage('This proposal was already applied.');
        void flagQuery.refetch();
        return;
      }
      setMessage(e instanceof Error ? e.message : 'Apply failed');
    }
  };

  return (
    <ScreenView bottomInset testID="ai-create-screen">
      <PageHeader
        title={proposal ? 'Review change' : 'Describe a change'}
        left={
          <PressableScale
            testID="ai-create-close"
            onPress={() => router.back()}
            hapticKind="selection"
            accessibilityRole="button"
            accessibilityLabel="Close"
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
            <Feather name="x" size={18} color={tokens.text.primary} />
          </PressableScale>
        }
        testID="ai-create-header"
      />

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          testID="ai-create-scroll"
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{
            paddingHorizontal: spacing.lg,
            paddingBottom: spacing.xxl,
            gap: spacing.lg,
          }}
        >
          {!projectId ? (
            <EmptyState
              testID="ai-create-no-project"
              icon="folder"
              title="No project selected"
              message="Pick a project on the Flags tab first."
            />
          ) : proposal ? (
            <>
              {flagQuery.isLoading ? (
                <Skeleton height={14} width="50%" testID="ai-create-flag-loading" />
              ) : null}
              <DiffPreview
                diff={proposal.diff}
                flag={flagQuery.data}
                flagLoading={flagQuery.isLoading}
              />
              {proposal.rationale ? (
                <Card testID="ai-create-rationale" style={{ gap: spacing.sm }}>
                  <Text style={[typography.label, { color: tokens.text.tertiary }]}>WHY</Text>
                  <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
                    {proposal.rationale}
                  </Text>
                </Card>
              ) : null}
              {message ? (
                <Text
                  testID="ai-create-message"
                  style={[typography.bodySm, { color: tokens.status.error }]}
                >
                  {message}
                </Text>
              ) : null}
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button
                  testID="ai-create-discard"
                  label="Discard"
                  variant="secondary"
                  style={{ flex: 1 }}
                  onPress={() => {
                    setProposal(null);
                    setMessage(null);
                  }}
                />
                <Button
                  testID="ai-create-apply"
                  label="Apply"
                  loading={apply.isPending}
                  style={{ flex: 1 }}
                  onPress={() => void onApply()}
                />
              </View>
            </>
          ) : (
            <>
              {flagParam ? (
                <Card testID="ai-create-context" style={{ gap: spacing.xs }}>
                  <Text style={[typography.label, { color: tokens.text.tertiary }]}>
                    ABOUT THIS FLAG
                  </Text>
                  <MonoText color={tokens.text.primary}>{flagParam}</MonoText>
                  {flagQuery.data ? (
                    <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
                      {flagQuery.data.name}
                      {flagQuery.data.description ? ` · ${flagQuery.data.description}` : ''}
                    </Text>
                  ) : null}
                </Card>
              ) : null}

              <TextInput
                testID="ai-create-prompt"
                label="What should change?"
                value={prompt}
                onChangeText={setPrompt}
                placeholder="Ramp new-checkout to 25% in staging"
                multiline
                numberOfLines={4}
                maxLength={MAX_PROMPT}
                autoCapitalize="sentences"
                editable={!unavailable}
                containerStyle={{ gap: spacing.xs }}
              />

              <View style={{ gap: spacing.sm }}>
                <Text style={[typography.label, { color: tokens.text.tertiary }]}>TRY</Text>
                <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                  {EXAMPLE_PROMPTS.map((example, i) => (
                    <Chip
                      key={example}
                      testID={`ai-create-example-${i}`}
                      label={example}
                      disabled={unavailable}
                      onPress={() => setPrompt(example)}
                    />
                  ))}
                </View>
              </View>

              <View style={{ gap: spacing.sm }}>
                <Text style={[typography.label, { color: tokens.text.tertiary }]}>ENVIRONMENT</Text>
                <SegmentedControl
                  testID="ai-create-env"
                  options={envOptions}
                  value={envChoice}
                  onChange={setEnvChoice}
                />
                <Text style={[typography.caption, { color: tokens.text.tertiary }]}>
                  Leave on Any to let the prompt decide.
                </Text>
              </View>

              {unavailable ? (
                aiDisabledByOrg ? (
                  <Card testID="ai-create-org-disabled" style={{ gap: spacing.sm }}>
                    <Text style={[typography.title, { color: tokens.text.primary }]}>
                      AI is turned off for this organization
                    </Text>
                    <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
                      An owner can turn it back on under Settings, in the AI section.
                    </Text>
                  </Card>
                ) : (
                  <AiUnavailableNotice testID="ai-create-unavailable" />
                )
              ) : null}

              {message ? (
                <Text
                  testID="ai-create-message"
                  style={[typography.bodySm, { color: tokens.status.error }]}
                >
                  {message}
                </Text>
              ) : null}

              <Button
                testID="ai-create-submit"
                label={unavailable ? 'Unavailable' : 'Draft the change'}
                loading={draft.isPending}
                disabled={!canSubmit}
                onPress={() => void onSubmit()}
              />
            </>
          )}
        </ScrollView>
      </KeyboardAvoidingView>
    </ScreenView>
  );
}
