import React from 'react';
import { View } from 'react-native';

import { radius, useTheme } from '@shared/theme';

export interface SplitSegment {
  key: string;
  /** Relative weight; segments are normalized against the total. */
  weight: number;
  color: string;
}

export interface SplitBarProps {
  segments: readonly SplitSegment[];
  height?: number;
  testID?: string;
}

/** Stacked traffic-split bar: one segment per variant, widths summing to 100%. */
export function SplitBar({ segments, height = 8, testID }: SplitBarProps) {
  const { tokens } = useTheme();
  const total = segments.reduce((sum, s) => sum + Math.max(0, s.weight), 0);
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        height,
        borderRadius: radius.pill,
        backgroundColor: tokens.surface.subtle,
        overflow: 'hidden',
      }}
    >
      {total <= 0
        ? null
        : segments.map((segment) => (
            <View
              key={segment.key}
              testID={testID ? `${testID}-${segment.key}` : undefined}
              style={{
                flex: Math.max(0, segment.weight),
                backgroundColor: segment.color,
              }}
            />
          ))}
    </View>
  );
}
