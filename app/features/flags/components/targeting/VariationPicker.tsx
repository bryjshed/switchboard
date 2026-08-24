import React from 'react';
import { View } from 'react-native';

import { spacing } from '@shared/theme';
import { Chip } from '@shared/ui';

import { variationLabel } from '../../lib/targeting';
import type { Variation } from '../../types';

export interface VariationPickerProps {
  variations: readonly Variation[];
  value: string | undefined;
  onChange: (variationId: string) => void;
  testID: string;
}

/** Chip row of a flag's variations. Boolean flags render as True/False. */
export function VariationPicker({ variations, value, onChange, testID }: VariationPickerProps) {
  return (
    <View testID={testID} style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
      {variations.map((v) => (
        <Chip
          key={v.id}
          testID={`${testID}-${v.value}`}
          label={variationLabel(variations, v.id)}
          selected={v.id === value}
          onPress={() => onChange(v.id)}
        />
      ))}
    </View>
  );
}
