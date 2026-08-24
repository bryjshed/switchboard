import React from 'react';
import { Text, type TextProps } from 'react-native';

import { useTheme } from '../theme';

export interface MonoTextProps extends TextProps {
  size?: 'md' | 'sm';
  color?: string;
}

/** Mono-slot helper for flag keys / context keys. */
export function MonoText({ size = 'md', color, style, children, ...rest }: MonoTextProps) {
  const { tokens, typography } = useTheme();
  return (
    <Text
      {...rest}
      style={[
        size === 'sm' ? typography.monoSm : typography.mono,
        { color: color ?? tokens.text.secondary },
        style,
      ]}
    >
      {children}
    </Text>
  );
}
