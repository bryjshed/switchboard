import Feather from '@expo/vector-icons/Feather';
import React, { useCallback, useState } from 'react';
import { Switch, Text, View } from 'react-native';

import { ApiClientError } from '@shared/api/client';
import { envLabel, envTone } from '@shared/lib/env';
import { relativeTime } from '@shared/lib/time';
import { radius, spacing, useTheme } from '@shared/theme';
import { Badge, Button, Card, ConfirmDialog, PressableScale, TextInput } from '@shared/ui';

import { RampSlider } from './RampSlider';
import {
  describeServe,
  isRollout,
  isTwoWayRamp,
  rampPercentage,
  targetingCounts,
  withRampPercent,
} from '../lib/targeting';
import { useEnvConfigMutation, useKillSwitchMutation, type FlagMutationScope } from '../mutations/flagMutations';
import type { FlagDetailResponse, FlagEnvConfigResponse } from '../types';

export interface EnvConfigCardProps {
  flag: FlagDetailResponse;
  envConfig: FlagEnvConfigResponse;
  scope: FlagMutationScope;
  onEditTargeting: (envKey: string) => void;
  onHistory: (envKey: string) => void;
  /** Called after a 409 so the screen can refetch the flag. */
  onConflict: () => void;
  /** A3: opens rollout health. Offered only when the fallthrough is a rollout. */
  onMonitor?: (envKey: string) => void;
  /** A3: OPEN anomaly findings for this flag in this env. */
  openFindingCount?: number;
}

const CONFLICT_MESSAGE = 'Config changed elsewhere — refreshed';

/**
 * One environment's controls: enabled switch, kill-switch bar, targeting
 * summary, and (when the fallthrough is a two-way rollout) the ramp slider.
 * Every write carries the loaded version as expectedVersion, so a config that
 * moved underneath us 409s instead of silently clobbering someone else's change.
 */
export function EnvConfigCard({
  flag,
  envConfig,
  scope,
  onEditTargeting,
  onHistory,
  onConflict,
  onMonitor,
  openFindingCount = 0,
}: EnvConfigCardProps) {
  const { tokens, typography } = useTheme();
  const [killDialog, setKillDialog] = useState(false);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState<string | null>(null);

  const envWrite = useEnvConfigMutation(scope);
  const killSwitch = useKillSwitchMutation(scope);

  const { envKey, config, enabled, killSwitchActive, version } = envConfig;
  const counts = targetingCounts(config);
  const ramp = rampPercentage(config);
  const showRamp = isTwoWayRamp(config);
  const showMonitor = !!onMonitor && isRollout(config.fallthrough);

  const write = useCallback(
    async (
      next: { enabled: boolean; config: FlagDetailResponse['envConfigs'][number]['config'] },
      comment: string,
    ) => {
      setMessage(null);
      try {
        await envWrite.mutateAsync({
          flagKey: flag.key,
          envKey,
          enabled: next.enabled,
          config: next.config,
          expectedVersion: version,
          comment,
        });
      } catch (e) {
        if (e instanceof ApiClientError && e.status === 409) {
          setMessage(CONFLICT_MESSAGE);
          onConflict();
          return;
        }
        setMessage(e instanceof Error ? e.message : 'Write failed');
      }
    },
    [envWrite, flag.key, envKey, version, onConflict],
  );

  const onToggleEnabled = (nextEnabled: boolean) =>
    void write({ enabled: nextEnabled, config }, nextEnabled ? 'enabled' : 'disabled');

  const onRampCommit = useCallback(
    (percent: number) =>
      void write({ enabled, config: withRampPercent(config, percent) }, `ramp ${percent}%`),
    [write, enabled, config],
  );

  const confirmKill = async () => {
    const nextActive = !killSwitchActive;
    setKillDialog(false);
    setMessage(null);
    try {
      await killSwitch.mutateAsync({
        flagKey: flag.key,
        envKey,
        active: nextActive,
        reason: reason.trim() || undefined,
      });
      setReason('');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : 'Kill switch failed');
    }
  };

  return (
    <Card testID={`env-card-${envKey}`} style={{ gap: spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Badge label={envLabel(envKey)} tone={envTone(envKey)} testID={`env-card-${envKey}-badge`} />
        <Text style={[typography.caption, { color: tokens.text.tertiary, flex: 1 }]}>
          v{version} · {relativeTime(envConfig.updatedAt)} · {envConfig.updatedBy}
        </Text>
        <Switch
          testID={`env-card-${envKey}-enabled`}
          value={enabled}
          disabled={envWrite.isPending}
          onValueChange={onToggleEnabled}
          trackColor={{ false: tokens.surface.subtle, true: tokens.accent.muted }}
          thumbColor={enabled ? tokens.accent.primary : tokens.surface.raised}
          ios_backgroundColor={tokens.surface.subtle}
        />
      </View>

      <View
        testID={`env-card-${envKey}-kill-bar`}
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          backgroundColor: killSwitchActive ? tokens.status.errorBg : tokens.surface.subtle,
          borderRadius: radius.sm,
          paddingHorizontal: spacing.md,
          paddingVertical: spacing.sm,
        }}
      >
        <Feather
          name={killSwitchActive ? 'alert-octagon' : 'shield'}
          size={16}
          color={killSwitchActive ? tokens.status.error : tokens.text.tertiary}
        />
        <Text
          style={[
            typography.bodySm,
            { flex: 1, color: killSwitchActive ? tokens.status.error : tokens.text.secondary },
          ]}
        >
          {killSwitchActive ? 'Kill switch active' : 'Kill switch off'}
        </Text>
        <Button
          testID={`env-card-${envKey}-kill-button`}
          label={killSwitchActive ? 'Release' : 'Kill'}
          size="sm"
          variant={killSwitchActive ? 'secondary' : 'destructive'}
          loading={killSwitch.isPending}
          onPress={() => setKillDialog(true)}
        />
      </View>

      {openFindingCount > 0 && onMonitor ? (
        <PressableScale
          testID={`env-card-${envKey}-anomaly-chip`}
          onPress={() => onMonitor(envKey)}
          hapticKind="warning"
          accessibilityRole="button"
          accessibilityLabel={`${openFindingCount} open findings on ${envKey}`}
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.xs,
            alignSelf: 'flex-start',
            backgroundColor: tokens.status.errorBg,
            borderRadius: radius.pill,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.xs,
          }}
        >
          <Feather name="alert-triangle" size={12} color={tokens.status.error} />
          <Text style={[typography.label, { color: tokens.status.error }]}>
            {openFindingCount === 1 ? '1 open finding' : `${openFindingCount} open findings`}
          </Text>
        </PressableScale>
      ) : null}

      <View style={{ gap: spacing.xs }}>
        <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
          {counts.ruleCount} {counts.ruleCount === 1 ? 'rule' : 'rules'} · {counts.targetCount}{' '}
          {counts.targetCount === 1 ? 'target' : 'targets'}
        </Text>
        <Text testID={`env-card-${envKey}-fallthrough`} style={[typography.bodySm, { color: tokens.text.primary }]}>
          Fallthrough: {describeServe(config.fallthrough, flag.variations)}
        </Text>
      </View>

      {showRamp ? (
        <RampSlider
          testID={`env-card-${envKey}-ramp`}
          value={ramp ?? 0}
          onCommit={onRampCommit}
          disabled={envWrite.isPending || killSwitchActive}
        />
      ) : null}

      {message ? (
        <Text
          testID={`env-card-${envKey}-message`}
          style={[
            typography.bodySm,
            { color: message === CONFLICT_MESSAGE ? tokens.status.warning : tokens.status.error },
          ]}
        >
          {message}
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <Button
          testID={`env-card-${envKey}-edit-targeting`}
          label="Edit targeting"
          variant="secondary"
          size="sm"
          style={{ flex: 1 }}
          onPress={() => onEditTargeting(envKey)}
        />
        <PressableScale
          testID={`env-card-${envKey}-history`}
          onPress={() => onHistory(envKey)}
          hapticKind="selection"
          accessibilityRole="button"
          accessibilityLabel={`History for ${envKey}`}
          style={{
            height: 34,
            paddingHorizontal: spacing.md,
            borderRadius: radius.sm,
            borderWidth: 1,
            borderColor: tokens.border.default,
            alignItems: 'center',
            justifyContent: 'center',
            flexDirection: 'row',
            gap: spacing.xs,
          }}
        >
          <Feather name="clock" size={14} color={tokens.text.secondary} />
          <Text style={[typography.label, { color: tokens.text.secondary }]}>History</Text>
        </PressableScale>
        {showMonitor ? (
          <PressableScale
            testID={`env-card-${envKey}-monitor`}
            onPress={() => onMonitor?.(envKey)}
            hapticKind="selection"
            accessibilityRole="button"
            accessibilityLabel={`Rollout health for ${envKey}`}
            style={{
              height: 34,
              paddingHorizontal: spacing.md,
              borderRadius: radius.sm,
              borderWidth: 1,
              borderColor: tokens.border.default,
              alignItems: 'center',
              justifyContent: 'center',
              flexDirection: 'row',
              gap: spacing.xs,
            }}
          >
            <Feather name="activity" size={14} color={tokens.text.secondary} />
            <Text style={[typography.label, { color: tokens.text.secondary }]}>Monitor</Text>
          </PressableScale>
        ) : null}
      </View>

      <ConfirmDialog
        testID={`env-card-${envKey}-kill-confirm`}
        visible={killDialog}
        title={killSwitchActive ? 'Release kill switch?' : `Kill ${flag.key} on ${envKey}?`}
        message={
          killSwitchActive
            ? 'Traffic resumes normal targeting immediately.'
            : 'All traffic immediately serves the off variation. Add a reason for the audit log.'
        }
        confirmLabel={killSwitchActive ? 'Release' : 'Kill'}
        destructive={!killSwitchActive}
        loading={killSwitch.isPending}
        onCancel={() => setKillDialog(false)}
        onConfirm={() => void confirmKill()}
      >
        <TextInput
          testID={`env-card-${envKey}-reason`}
          label="Reason (audit log)"
          value={reason}
          onChangeText={setReason}
          placeholder="Checkout errors spiking"
          autoCapitalize="sentences"
        />
      </ConfirmDialog>
    </Card>
  );
}
