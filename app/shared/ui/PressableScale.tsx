import React from 'react';
import { Pressable, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from 'react-native-reanimated';

import { haptic, type HapticKind } from '../haptics';

const SPRING = { damping: 18, stiffness: 240 } as const;

export interface PressableScaleProps extends PressableProps {
  /** Fire this haptic on press-in. */
  hapticKind?: HapticKind;
  style?: StyleProp<ViewStyle>;
  children?: React.ReactNode;
}

/**
 * Press feedback primitive: springs to 0.97 scale. Under reduced motion the
 * scale is skipped and a plain opacity dip is used instead.
 */
export function PressableScale({
  hapticKind,
  style,
  children,
  onPressIn,
  onPressOut,
  ...rest
}: PressableScaleProps) {
  const reducedMotion = useReducedMotion();
  const pressed = useSharedValue(0);

  const animatedStyle = useAnimatedStyle(() => {
    if (reducedMotion) {
      return { transform: [{ scale: 1 }], opacity: pressed.value ? 0.7 : 1 };
    }
    return {
      transform: [{ scale: withSpring(pressed.value ? 0.97 : 1, SPRING) }],
      opacity: 1,
    };
  });

  return (
    <Pressable
      {...rest}
      onPressIn={(e) => {
        pressed.value = 1;
        if (hapticKind) haptic(hapticKind);
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        pressed.value = 0;
        onPressOut?.(e);
      }}
    >
      <Animated.View style={[animatedStyle, style]}>{children}</Animated.View>
    </Pressable>
  );
}
