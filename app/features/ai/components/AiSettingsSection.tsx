import Feather from '@expo/vector-icons/Feather';
import { useQuery } from '@tanstack/react-query';
import React, { useState } from 'react';
import { Switch, Text, View } from 'react-native';

import { useOrgSettingsMutation } from '@features/orgs/mutations/orgMutations';
import { orgSettingsOptions } from '@features/orgs/queries/orgQueries';
import { radius, spacing, useTheme } from '@shared/theme';
import type { OrgRole } from '@shared/api/types';
import { Card, PressableScale, Skeleton } from '@shared/ui';

export interface AiSettingsSectionProps {
  userId: string | undefined;
  orgId: string | undefined;
  role: OrgRole | undefined;
  testID?: string;
}

const MIN_WEEKS = 1;
const MAX_WEEKS = 52;

/**
 * Org-level AI switches.
 *
 * The two auto toggles let Switchboard change production without a human in the
 * loop, so each one says plainly what it will do on its own and where the
 * record lands. Owner-only: members see the same state, read-only, with the
 * reason spelled out rather than a silently dead control.
 */
export function AiSettingsSection({ userId, orgId, role, testID = 'settings-ai' }: AiSettingsSectionProps) {
  const { tokens, typography } = useTheme();
  const settingsQuery = useQuery(orgSettingsOptions(userId, orgId));
  const update = useOrgSettingsMutation({ userId, orgId });
  const [error, setError] = useState<string | null>(null);

  const settings = settingsQuery.data;
  const canEdit = role === 'OWNER';
  const disabled = !canEdit || update.isPending;

  const write = async (body: Parameters<typeof update.mutateAsync>[0]) => {
    setError(null);
    try {
      await update.mutateAsync(body);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save');
    }
  };

  if (settingsQuery.isLoading && !settings) {
    return (
      <Card testID={`${testID}-loading`} style={{ gap: spacing.md }}>
        <Skeleton height={16} width="55%" />
        <Skeleton height={16} width="70%" />
        <Skeleton height={16} width="45%" />
      </Card>
    );
  }

  if (!settings) {
    return (
      <Card testID={`${testID}-unavailable`}>
        <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
          Settings could not be loaded for this organization.
        </Text>
      </Card>
    );
  }

  return (
    <Card testID={testID} padded={false}>
      <ToggleRow
        testID={`${testID}-enabled`}
        title="AI changes"
        caption="Lets you describe a flag change in words and get a reviewable proposal back. Nothing is applied until you approve it."
        value={settings.aiEnabled}
        disabled={disabled}
        onChange={(aiEnabled) => void write({ aiEnabled })}
      />
      <Divider />
      <ToggleRow
        testID={`${testID}-auto-rollback`}
        title="Heal bad rollouts"
        caption="Roll back a rollout automatically when a variant starts erroring. Switchboard makes the change on its own and writes it to the audit log."
        value={settings.autoRollbackEnabled}
        disabled={disabled}
        onChange={(autoRollbackEnabled) => void write({ autoRollbackEnabled })}
      />
      <Divider />
      <ToggleRow
        testID={`${testID}-auto-optimize`}
        title="Ramp up winners"
        caption="Ramp up a variant that is converting better. Traffic shifts without anyone approving it, so leave this off while an experiment is still collecting data."
        value={settings.autoOptimizeEnabled}
        disabled={disabled}
        onChange={(autoOptimizeEnabled) => void write({ autoOptimizeEnabled })}
      />
      <Divider />
      <View style={{ padding: spacing.lg, gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View style={{ flex: 1 }}>
            <Text style={[typography.subtitle, { color: tokens.text.primary }]}>Stale after</Text>
            <Text style={[typography.caption, { color: tokens.text.secondary, marginTop: 2 }]}>
              How long a flag can sit untouched before it is suggested for retirement.
            </Text>
          </View>
          <Stepper
            testID={`${testID}-stale-weeks`}
            value={settings.staleFlagWeeks}
            disabled={disabled}
            onChange={(staleFlagWeeks) => void write({ staleFlagWeeks })}
          />
        </View>
      </View>
      {!canEdit ? (
        <Text
          testID={`${testID}-member-note`}
          style={[
            typography.caption,
            {
              color: tokens.text.tertiary,
              paddingHorizontal: spacing.lg,
              paddingBottom: spacing.lg,
            },
          ]}
        >
          Only an organization owner can change these.
        </Text>
      ) : null}
      {error ? (
        <Text
          testID={`${testID}-error`}
          style={[
            typography.caption,
            {
              color: tokens.status.error,
              paddingHorizontal: spacing.lg,
              paddingBottom: spacing.lg,
            },
          ]}
        >
          {error}
        </Text>
      ) : null}
    </Card>
  );
}

function Divider() {
  const { tokens } = useTheme();
  return <View style={{ height: 1, backgroundColor: tokens.border.subtle }} />;
}

function ToggleRow({
  title,
  caption,
  value,
  disabled,
  onChange,
  testID,
}: {
  title: string;
  caption: string;
  value: boolean;
  disabled: boolean;
  onChange: (next: boolean) => void;
  testID: string;
}) {
  const { tokens, typography } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'flex-start',
        gap: spacing.md,
        padding: spacing.lg,
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={[typography.subtitle, { color: tokens.text.primary }]}>{title}</Text>
        <Text style={[typography.caption, { color: tokens.text.secondary, marginTop: 2 }]}>
          {caption}
        </Text>
      </View>
      <Switch
        testID={testID}
        value={value}
        disabled={disabled}
        onValueChange={onChange}
        trackColor={{ false: tokens.surface.subtle, true: tokens.accent.muted }}
        thumbColor={value ? tokens.accent.primary : tokens.surface.raised}
        ios_backgroundColor={tokens.surface.subtle}
      />
    </View>
  );
}

function Stepper({
  value,
  disabled,
  onChange,
  testID,
}: {
  value: number;
  disabled: boolean;
  onChange: (next: number) => void;
  testID: string;
}) {
  const { tokens, typography } = useTheme();
  const step = (delta: number) => {
    const next = Math.max(MIN_WEEKS, Math.min(MAX_WEEKS, value + delta));
    if (next !== value) onChange(next);
  };
  const button = (icon: 'minus' | 'plus', delta: number, blocked: boolean) => (
    <PressableScale
      testID={`${testID}-${icon}`}
      onPress={() => step(delta)}
      disabled={disabled || blocked}
      hapticKind="selection"
      accessibilityRole="button"
      accessibilityLabel={icon === 'minus' ? 'Fewer weeks' : 'More weeks'}
      style={{
        width: 34,
        height: 34,
        borderRadius: radius.sm,
        alignItems: 'center',
        justifyContent: 'center',
        backgroundColor: tokens.surface.subtle,
        opacity: disabled || blocked ? 0.4 : 1,
      }}
    >
      <Feather name={icon} size={16} color={tokens.text.primary} />
    </PressableScale>
  );
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
      {button('minus', -1, value <= MIN_WEEKS)}
      <Text
        testID={`${testID}-value`}
        style={[typography.subtitle, { color: tokens.text.primary, minWidth: 52, textAlign: 'center' }]}
      >
        {value} {value === 1 ? 'week' : 'weeks'}
      </Text>
      {button('plus', 1, value >= MAX_WEEKS)}
    </View>
  );
}
