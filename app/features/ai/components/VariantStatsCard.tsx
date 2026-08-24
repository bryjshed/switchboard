import React from 'react';
import { Text, View } from 'react-native';

import { spacing, useTheme } from '@shared/theme';
import { Badge, Card, MonoText } from '@shared/ui';
import type { RolloutStatsBucket, VariantStats } from '@shared/api/types';

import { formatCount, formatRate, seriesTrend, variantSeries } from '../lib/rolloutStats';
import { RateBar } from './RateBar';
import { Sparkline } from './Sparkline';
import { TrendIndicator } from './TrendIndicator';

export interface VariantStatsCardProps {
  variant: VariantStats;
  /** Variation value (mono), when the flag detail is loaded. */
  value?: string;
  color: string;
  buckets: readonly RolloutStatsBucket[];
  /** Largest rates in the comparison group so every bar shares one scale. */
  maxErrorRate: number;
  maxConversionRate: number;
  leading?: boolean;
  erroring?: boolean;
  testID?: string;
}

/**
 * One variant's column of the comparison: counts, both rates as shared-scale
 * bars, and an hourly sparkline of its error rate. A variant erroring well
 * above its peers gets the status.error treatment, and the conversion leader
 * gets a quiet badge — the two judgements a human needs to make here.
 */
export function VariantStatsCard({
  variant,
  value,
  color,
  buckets,
  maxErrorRate,
  maxConversionRate,
  leading = false,
  erroring = false,
  testID,
}: VariantStatsCardProps) {
  const { tokens, typography } = useTheme();
  const id = testID ?? `variant-${variant.variationId}`;
  const errorSeries = variantSeries(buckets, variant.variationId, 'errorRate');
  const trend = seriesTrend(errorSeries);

  return (
    <Card
      testID={id}
      style={{
        gap: spacing.md,
        borderColor: erroring ? tokens.status.error : tokens.border.subtle,
        backgroundColor: erroring ? tokens.status.errorBg : tokens.surface.raised,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <View style={{ width: 10, height: 10, borderRadius: 5, backgroundColor: color }} />
        <Text style={[typography.title, { color: tokens.text.primary }]} numberOfLines={1}>
          {variant.variationName?.trim() || 'Variant'}
        </Text>
        {value ? <MonoText size="sm">{value}</MonoText> : null}
        <View style={{ flex: 1 }} />
        {leading ? <Badge testID={`${id}-leading`} label="Leading" tone="success" /> : null}
        {erroring ? <Badge testID={`${id}-erroring`} label="Erroring" tone="error" /> : null}
      </View>

      <Text testID={`${id}-evals`} style={[typography.bodySm, { color: tokens.text.secondary }]}>
        {formatCount(variant.evalCount)} evaluations
      </Text>

      <MetricRow
        testID={`${id}-error`}
        label="Error rate"
        value={formatRate(variant.errorRate)}
        rate={variant.errorRate}
        max={maxErrorRate}
        color={erroring ? tokens.status.error : color}
        emphasis={erroring ? tokens.status.error : undefined}
      />
      <MetricRow
        testID={`${id}-conversion`}
        label="Conversion rate"
        value={formatRate(variant.conversionRate)}
        rate={variant.conversionRate}
        max={maxConversionRate}
        color={color}
        emphasis={leading ? tokens.status.success : undefined}
      />

      <View style={{ gap: spacing.xs }}>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          <Text style={[typography.caption, { color: tokens.text.tertiary, flex: 1 }]}>
            Errors per hour
          </Text>
          <TrendIndicator
            testID={`${id}-trend`}
            trend={trend}
            label={trend === 'flat' ? 'steady' : trend === 'up' ? 'rising' : 'falling'}
          />
        </View>
        <Sparkline
          testID={`${id}-sparkline`}
          values={errorSeries}
          color={erroring ? tokens.status.error : color}
        />
      </View>
    </Card>
  );
}

function MetricRow({
  label,
  value,
  rate,
  max,
  color,
  emphasis,
  testID,
}: {
  label: string;
  value: string;
  rate: number;
  max: number;
  color: string;
  emphasis?: string;
  testID?: string;
}) {
  const { tokens, typography } = useTheme();
  return (
    <View style={{ gap: spacing.xs }} testID={testID}>
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        <Text style={[typography.caption, { color: tokens.text.tertiary, flex: 1 }]}>{label}</Text>
        <Text
          testID={testID ? `${testID}-value` : undefined}
          style={[typography.subtitle, { color: emphasis ?? tokens.text.primary }]}
        >
          {value}
        </Text>
      </View>
      <RateBar value={rate} max={max} color={color} />
    </View>
  );
}
