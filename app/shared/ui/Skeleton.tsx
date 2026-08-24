import React, { useEffect } from 'react';
import type { DimensionValue, StyleProp, ViewStyle } from 'react-native';
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { radius as radiusScale, useTheme } from '../theme';

export interface SkeletonProps {
  width?: DimensionValue;
  height?: DimensionValue;
  radius?: number;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * Loading placeholder: one full-shape opacity pulse (no sweeping shimmer).
 * Static under reduced motion.
 */
export function Skeleton({
  width = '100%',
  height = 16,
  radius = radiusScale.sm,
  style,
  testID,
}: SkeletonProps) {
  const { tokens } = useTheme();
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(0.5);

  useEffect(() => {
    if (reducedMotion) return;
    pulse.value = withRepeat(
      withTiming(1, { duration: 700, easing: Easing.inOut(Easing.ease) }),
      -1,
      true,
    );
  }, [pulse, reducedMotion]);

  const animatedStyle = useAnimatedStyle(() => ({ opacity: reducedMotion ? 0.6 : pulse.value }));

  return (
    <Animated.View
      testID={testID}
      style={[
        { width, height, borderRadius: radius, backgroundColor: tokens.surface.subtle },
        animatedStyle,
        style,
      ]}
    />
  );
}
