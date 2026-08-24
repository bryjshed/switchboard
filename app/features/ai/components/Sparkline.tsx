import React from 'react';
import { View } from 'react-native';

import { radius, useTheme } from '@shared/theme';

export interface SparklineProps {
  /** One value per time bucket, oldest first. */
  values: readonly number[];
  color: string;
  height?: number;
  testID?: string;
}

/**
 * Bucket-per-bar sparkline drawn with Views.
 *
 * react-native-svg is not a dependency (direct or transitive) and a charting
 * library is out of scope for one 28px strip, so each bucket is a flex-weighted
 * bar scaled against the series maximum. An all-zero series still renders a
 * baseline so "no errors" looks different from "no data".
 */
export function Sparkline({ values, color, height = 28, testID }: SparklineProps) {
  const { tokens } = useTheme();
  const max = values.reduce((m, v) => (Number.isFinite(v) && v > m ? v : m), 0);
  if (values.length === 0) {
    return (
      <View
        testID={testID}
        style={{ height, justifyContent: 'flex-end' }}
      >
        <View style={{ height: 1, backgroundColor: tokens.border.subtle }} />
      </View>
    );
  }
  return (
    <View
      testID={testID}
      accessibilityRole="image"
      accessibilityLabel={`Trend over ${values.length} buckets`}
      style={{ height, flexDirection: 'row', alignItems: 'flex-end', gap: 2 }}
    >
      {values.map((value, i) => {
        const ratio = max > 0 ? Math.max(0, value) / max : 0;
        const barHeight = Math.max(2, Math.round(ratio * height));
        return (
          <View
            key={i}
            style={{
              flex: 1,
              height: barHeight,
              minWidth: 2,
              borderRadius: radius.sm / 4,
              backgroundColor: ratio > 0 ? color : tokens.border.default,
            }}
          />
        );
      })}
    </View>
  );
}
