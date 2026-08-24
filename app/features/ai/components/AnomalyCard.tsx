import React from 'react';
import { Text, View } from 'react-native';

import { relativeTime } from '@shared/lib/time';
import { radius, spacing, useTheme } from '@shared/theme';
import { Badge, Button, Card, MonoText } from '@shared/ui';
import type { AnomalyFindingResponse, AnomalyStatus } from '@shared/api/types';

import { formatRate } from '../lib/rolloutStats';

export interface AnomalyCardProps {
  finding: AnomalyFindingResponse;
  /** Hidden unless the finding is OPEN. */
  onAcknowledge?: () => void;
  acknowledging?: boolean;
  onReviewProposal?: () => void;
  testID?: string;
}

function statusMeta(status: AnomalyStatus): { label: string; tone: 'error' | 'neutral' | 'warning' } {
  switch (status) {
    case 'OPEN':
      return { label: 'Open', tone: 'error' };
    case 'ACKED':
      return { label: 'Acknowledged', tone: 'neutral' };
    case 'AUTO_ROLLED_BACK':
      return { label: 'Auto rolled back', tone: 'warning' };
  }
}

/**
 * One anomaly finding: what the detector saw (baseline vs variant, z-score),
 * its own words, and the two things you can do about it.
 */
export function AnomalyCard({
  finding,
  onAcknowledge,
  acknowledging = false,
  onReviewProposal,
  testID,
}: AnomalyCardProps) {
  const { tokens, typography } = useTheme();
  const meta = statusMeta(finding.status);
  const id = testID ?? `anomaly-${finding.id}`;
  const worse = finding.variantRate > finding.baselineRate;

  return (
    <Card testID={id} style={{ gap: spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Badge label={meta.label} tone={meta.tone} testID={`${id}-status`} />
        <MonoText size="sm" style={{ flex: 1 }} numberOfLines={1}>
          {finding.flagKey}
        </MonoText>
        <Text style={[typography.caption, { color: tokens.text.tertiary }]}>
          {relativeTime(finding.createdAt)}
        </Text>
      </View>

      <View
        style={{
          flexDirection: 'row',
          backgroundColor: tokens.surface.subtle,
          borderRadius: radius.sm,
          paddingVertical: spacing.sm,
        }}
      >
        <Metric label="Baseline" value={formatRate(finding.baselineRate)} />
        <Metric
          label={finding.metricKey === 'error' ? 'This variant' : `Variant ${finding.metricKey}`}
          value={formatRate(finding.variantRate)}
          emphasis={worse ? tokens.status.error : tokens.status.success}
          testID={`${id}-variant-rate`}
        />
        <Metric label="z-score" value={finding.zScore.toFixed(2)} testID={`${id}-zscore`} />
      </View>

      {finding.summary ? (
        <Text testID={`${id}-summary`} style={[typography.bodySm, { color: tokens.text.secondary }]}>
          {finding.summary}
        </Text>
      ) : null}

      {onAcknowledge || onReviewProposal ? (
        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {finding.suggestedProposalId && onReviewProposal ? (
            <Button
              testID={`${id}-review`}
              label="Review proposal"
              variant="secondary"
              size="sm"
              style={{ flex: 1 }}
              onPress={onReviewProposal}
            />
          ) : null}
          {finding.status === 'OPEN' && onAcknowledge ? (
            <Button
              testID={`${id}-ack`}
              label="Acknowledge"
              variant="secondary"
              size="sm"
              loading={acknowledging}
              style={{ flex: 1 }}
              onPress={onAcknowledge}
            />
          ) : null}
        </View>
      ) : null}
    </Card>
  );
}

function Metric({
  label,
  value,
  emphasis,
  testID,
}: {
  label: string;
  value: string;
  emphasis?: string;
  testID?: string;
}) {
  const { tokens, typography } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', gap: spacing.xxs }}>
      <Text style={[typography.caption, { color: tokens.text.tertiary }]}>{label}</Text>
      <Text testID={testID} style={[typography.subtitle, { color: emphasis ?? tokens.text.primary }]}>
        {value}
      </Text>
    </View>
  );
}
