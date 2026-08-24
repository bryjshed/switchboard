import React, { useMemo, useState } from 'react';
import { Text, View } from 'react-native';

import { orderEnvKeys } from '@shared/lib/env';
import { relativeTime } from '@shared/lib/time';
import { spacing, useTheme, type EnvTint, type ThemeTokens } from '@shared/theme';
import { haptic } from '@shared/haptics';
import {
  Badge,
  Card,
  ConfirmDialog,
  MonoText,
  PressableScale,
  ProgressBar,
  StatusDot,
  type StatusDotTone,
} from '@shared/ui';

import type { FlagEnvSummary, FlagSummaryResponse } from '../types';

export interface FlagCardProps {
  flag: FlagSummaryResponse;
  /** Env the list is scoped to; drives the ramp bar + change caption. */
  activeEnvKey: string;
  onPress?: () => void;
  /** Long-press → confirm → fire with the state the switch should move to. */
  onKillSwitch?: (nextActive: boolean) => void;
}

function envStateTone(env: FlagEnvSummary): StatusDotTone {
  if (env.killSwitchActive) return 'error';
  return env.enabled ? 'success' : 'neutral';
}

/** Envs beyond dev/staging/production have no identity tint — use the neutral pair. */
function envPair(tokens: ThemeTokens, envKey: string): EnvTint {
  if (envKey === 'dev' || envKey === 'staging' || envKey === 'production') {
    return tokens.tints[envKey];
  }
  return { bg: tokens.surface.subtle, ink: tokens.text.secondary };
}

/**
 * Flagship list row: name + mono key, right-aligned per-env state pills
 * (StatusDot + env tint), rollout ramp bar when the active env is ramping,
 * last-change caption, long-press kill-switch confirm.
 */
export function FlagCard({ flag, activeEnvKey, onPress, onKillSwitch }: FlagCardProps) {
  const { tokens, typography } = useTheme();
  const [confirmVisible, setConfirmVisible] = useState(false);

  const envs = useMemo(() => orderEnvKeys(flag.environments), [flag.environments]);
  const activeEnv = useMemo(
    () => envs.find((e) => e.envKey === activeEnvKey),
    [envs, activeEnvKey],
  );
  const ramping =
    activeEnv?.enabled && !activeEnv.killSwitchActive && activeEnv.rolloutPercentage != null;
  const changeCaption =
    activeEnv?.updatedAt && activeEnv.updatedBy
      ? `changed ${relativeTime(activeEnv.updatedAt)} · ${activeEnv.updatedBy}`
      : null;
  const killActive = !!activeEnv?.killSwitchActive;

  return (
    <>
      <PressableScale
        testID={`flag-card-${flag.key}`}
        onPress={onPress}
        onLongPress={
          onKillSwitch && activeEnv
            ? () => {
                haptic('warning');
                setConfirmVisible(true);
              }
            : undefined
        }
        accessibilityRole="button"
        accessibilityLabel={`Flag ${flag.name}`}
      >
        <Card>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md }}>
            <View style={{ flex: 1 }}>
              <Text style={[typography.title, { color: tokens.text.primary }]} numberOfLines={1}>
                {flag.name}
              </Text>
              <MonoText size="sm" style={{ marginTop: spacing.xxs }} numberOfLines={1}>
                {flag.key}
              </MonoText>
            </View>
            <View
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                justifyContent: 'flex-end',
                gap: spacing.xs,
                maxWidth: '52%',
              }}
            >
              {envs.map((env) => {
                const tint = envPair(tokens, env.envKey);
                return (
                  <View
                    key={env.envKey}
                    testID={`flag-card-${flag.key}-env-${env.envKey}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: spacing.xs,
                      backgroundColor: tint.bg,
                      borderRadius: 999,
                      paddingHorizontal: spacing.sm,
                      paddingVertical: spacing.xxs + 1,
                      opacity: env.envKey === activeEnvKey ? 1 : 0.6,
                    }}
                  >
                    <StatusDot tone={envStateTone(env)} size={6} />
                    <Text style={[typography.monoSm, { color: tint.ink }]}>
                      {env.envKey === 'production' ? 'prod' : env.envKey}
                    </Text>
                  </View>
                );
              })}
            </View>
          </View>

          {ramping ? (
            <View style={{ marginTop: spacing.md }}>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'space-between',
                  marginBottom: spacing.xs,
                }}
              >
                <Text style={[typography.caption, { color: tokens.text.secondary }]}>
                  Ramping on {activeEnvKey}
                </Text>
                <Text style={[typography.caption, { color: tokens.accent.primaryDark }]}>
                  {activeEnv.rolloutPercentage}%
                </Text>
              </View>
              <ProgressBar
                value={activeEnv.rolloutPercentage ?? 0}
                testID={`flag-card-${flag.key}-ramp`}
              />
            </View>
          ) : null}

          {killActive ? (
            <Badge label="Kill switch active" tone="error" style={{ marginTop: spacing.md }} />
          ) : null}

          {changeCaption ? (
            <Text
              testID={`flag-card-${flag.key}-changed`}
              style={[typography.caption, { color: tokens.text.tertiary, marginTop: spacing.md }]}
            >
              {changeCaption}
            </Text>
          ) : null}
        </Card>
      </PressableScale>

      <ConfirmDialog
        testID={`flag-card-${flag.key}-kill-confirm`}
        visible={confirmVisible}
        title={killActive ? 'Release kill switch?' : 'Activate kill switch?'}
        message={
          killActive
            ? `Traffic on ${activeEnvKey} resumes normal targeting for ${flag.key}.`
            : `All traffic on ${activeEnvKey} immediately serves the off variation for ${flag.key}.`
        }
        confirmLabel={killActive ? 'Release' : 'Kill'}
        destructive={!killActive}
        onCancel={() => setConfirmVisible(false)}
        onConfirm={() => {
          setConfirmVisible(false);
          onKillSwitch?.(!killActive);
        }}
      />
    </>
  );
}
