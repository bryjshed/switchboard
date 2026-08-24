import React from 'react';
import { Text, View } from 'react-native';

import { spacing, useTheme } from '@shared/theme';
import { Button, SegmentedControl, TextInput } from '@shared/ui';

import { isRollout, rolloutSum, variationLabel } from '../../lib/targeting';
import type { RolloutOrVariation, Variation } from '../../types';
import { VariationPicker } from './VariationPicker';

export interface ServeEditorProps {
  label: string;
  variations: readonly Variation[];
  serve: RolloutOrVariation;
  onChange: (serve: RolloutOrVariation) => void;
  testID: string;
}

type Mode = 'variation' | 'rollout';

const MODE_OPTIONS: { value: Mode; label: string }[] = [
  { value: 'variation', label: 'Variation' },
  { value: 'rollout', label: 'Rollout' },
];

function evenSplit(variations: readonly Variation[]) {
  const base = Math.floor(100 / variations.length);
  return variations.map((v, i) => ({
    variationId: v.id,
    // Remainder rides on the first row so the weights always total exactly 100.
    weight: i === 0 ? 100 - base * (variations.length - 1) : base,
  }));
}

/**
 * Serve slot editor: a fixed variation or a weighted rollout. The two shapes are
 * mutually exclusive in the contract, so switching modes replaces the value
 * rather than merging — a serve carrying both would be rejected server-side.
 */
export function ServeEditor({ label, variations, serve, onChange, testID }: ServeEditorProps) {
  const { tokens, typography } = useTheme();
  const mode: Mode = isRollout(serve) ? 'rollout' : 'variation';
  const rollout = serve.rollout ?? [];
  const sum = rolloutSum(rollout);
  const sumValid = sum === 100;

  const weightFor = (variationId: string) =>
    rollout.find((w) => w.variationId === variationId)?.weight ?? 0;

  const setWeight = (variationId: string, raw: string) => {
    const parsed = Number.parseInt(raw.replace(/[^0-9]/g, ''), 10);
    const weight = Number.isNaN(parsed) ? 0 : Math.min(100, parsed);
    const next = variations.map((v) => ({
      variationId: v.id,
      weight: v.id === variationId ? weight : weightFor(v.id),
    }));
    onChange({ rollout: next });
  };

  return (
    <View testID={testID} style={{ gap: spacing.sm }}>
      <Text style={[typography.label, { color: tokens.text.secondary }]}>{label}</Text>
      <SegmentedControl
        testID={`${testID}-mode`}
        options={MODE_OPTIONS}
        value={mode}
        onChange={(next) =>
          onChange(
            next === 'rollout'
              ? { rollout: evenSplit(variations) }
              : { variationId: serve.variationId ?? variations[0]?.id },
          )
        }
      />
      {mode === 'variation' ? (
        <VariationPicker
          testID={`${testID}-variation`}
          variations={variations}
          value={serve.variationId}
          onChange={(variationId) => onChange({ variationId })}
        />
      ) : (
        <View style={{ gap: spacing.sm }}>
          {variations.map((v) => (
            <View
              key={v.id}
              style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
            >
              <Text style={[typography.bodySm, { flex: 1, color: tokens.text.primary }]}>
                {variationLabel(variations, v.id)}
              </Text>
              <TextInput
                testID={`${testID}-weight-${v.value}`}
                containerStyle={{ width: 90 }}
                value={String(weightFor(v.id))}
                keyboardType="number-pad"
                onChangeText={(raw) => setWeight(v.id, raw)}
              />
            </View>
          ))}
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
            <Text
              testID={`${testID}-sum`}
              style={[
                typography.label,
                { flex: 1, color: sumValid ? tokens.status.success : tokens.status.error },
              ]}
            >
              {sum}% of 100%
            </Text>
            <Button
              testID={`${testID}-even`}
              label="Even split"
              variant="secondary"
              size="sm"
              onPress={() => onChange({ rollout: evenSplit(variations) })}
            />
          </View>
        </View>
      )}
    </View>
  );
}
