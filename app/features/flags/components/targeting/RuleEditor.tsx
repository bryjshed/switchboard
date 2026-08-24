import Feather from '@expo/vector-icons/Feather';
import React, { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { radius, spacing, useTheme } from '@shared/theme';
import { Button, Card, Chip, MonoText, TextInput } from '@shared/ui';

import type { Clause, ClauseOp, Rule, RolloutOrVariation, Variation } from '../../types';
import { ServeEditor } from './ServeEditor';

export interface RuleEditorProps {
  rule: Rule;
  index: number;
  variations: readonly Variation[];
  onUpdateClause: (clauseIndex: number, patch: Partial<Clause>) => void;
  onAddClause: () => void;
  onRemoveClause: (clauseIndex: number) => void;
  onServeChange: (serve: RolloutOrVariation) => void;
  onRemove: () => void;
}

const OPS: { value: ClauseOp; label: string }[] = [
  { value: 'EQUALS', label: 'equals' },
  { value: 'IN', label: 'in' },
  { value: 'CONTAINS', label: 'contains' },
  { value: 'STARTS_WITH', label: 'starts with' },
  { value: 'SEGMENT_MATCH', label: 'in segment' },
  { value: 'NOT_SEGMENT_MATCH', label: 'not in segment' },
];

/** One targeting rule: its clauses (all must match) and what it serves. */
export function RuleEditor({
  rule,
  index,
  variations,
  onUpdateClause,
  onAddClause,
  onRemoveClause,
  onServeChange,
  onRemove,
}: RuleEditorProps) {
  const { tokens, typography } = useTheme();
  const testID = `rule-${index}`;

  return (
    <Card testID={testID} style={{ gap: spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Text style={[typography.label, { flex: 1, color: tokens.text.secondary }]}>
          RULE {index + 1}
        </Text>
        <Pressable
          testID={`${testID}-remove`}
          accessibilityRole="button"
          accessibilityLabel={`Remove rule ${index + 1}`}
          hitSlop={8}
          onPress={onRemove}
        >
          <Feather name="trash-2" size={16} color={tokens.status.error} />
        </Pressable>
      </View>

      {rule.clauses.map((clause, clauseIndex) => (
        <ClauseEditor
          key={`${rule.id}-${clauseIndex}`}
          testID={`${testID}-clause-${clauseIndex}`}
          clause={clause}
          canRemove={rule.clauses.length > 1}
          onChange={(patch) => onUpdateClause(clauseIndex, patch)}
          onRemove={() => onRemoveClause(clauseIndex)}
        />
      ))}

      <Button
        testID={`${testID}-add-clause`}
        label="Add clause"
        variant="secondary"
        size="sm"
        onPress={onAddClause}
      />

      <ServeEditor
        testID={`${testID}-serve`}
        label="Serve"
        variations={variations}
        serve={rule.serve}
        onChange={onServeChange}
      />
    </Card>
  );
}

interface ClauseEditorProps {
  clause: Clause;
  canRemove: boolean;
  onChange: (patch: Partial<Clause>) => void;
  onRemove: () => void;
  testID: string;
}

/**
 * Attribute + operator + values. Values are chips because every op the API
 * accepts is set-valued (IN and SEGMENT_MATCH take many, the rest take one and
 * ignore the extras) — a comma-joined string would hide that.
 */
function ClauseEditor({ clause, canRemove, onChange, onRemove, testID }: ClauseEditorProps) {
  const { tokens, typography } = useTheme();
  const [draft, setDraft] = useState('');
  const segmentOp = clause.op === 'SEGMENT_MATCH' || clause.op === 'NOT_SEGMENT_MATCH';

  const addValue = () => {
    const value = draft.trim();
    if (!value || clause.values.includes(value)) {
      setDraft('');
      return;
    }
    onChange({ values: [...clause.values, value] });
    setDraft('');
  };

  return (
    <View
      testID={testID}
      style={{
        gap: spacing.sm,
        padding: spacing.md,
        borderRadius: radius.sm,
        backgroundColor: tokens.surface.subtle,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: spacing.sm }}>
        <TextInput
          testID={`${testID}-attribute`}
          containerStyle={{ flex: 1 }}
          label="Attribute"
          value={clause.attribute}
          mono
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={segmentOp ? 'key' : 'plan'}
          onChangeText={(attribute) => onChange({ attribute })}
        />
        {canRemove ? (
          <Pressable
            testID={`${testID}-remove`}
            accessibilityRole="button"
            accessibilityLabel="Remove clause"
            hitSlop={8}
            onPress={onRemove}
            style={{ height: 44, justifyContent: 'center' }}
          >
            <Feather name="minus-circle" size={18} color={tokens.text.tertiary} />
          </Pressable>
        ) : null}
      </View>

      <Text style={[typography.label, { color: tokens.text.secondary }]}>Operator</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
        {OPS.map((op) => (
          <Chip
            key={op.value}
            testID={`${testID}-op-${op.value}`}
            label={op.label}
            selected={clause.op === op.value}
            onPress={() => onChange({ op: op.value })}
          />
        ))}
      </View>

      <Text style={[typography.label, { color: tokens.text.secondary }]}>
        {segmentOp ? 'Segment keys' : 'Values'}
      </Text>
      {clause.values.length > 0 ? (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {clause.values.map((value) => (
            <Chip
              key={value}
              testID={`${testID}-value-${value}`}
              label={`${value}  ×`}
              selected
              onPress={() => onChange({ values: clause.values.filter((v) => v !== value) })}
            />
          ))}
        </View>
      ) : (
        <MonoText size="sm">no values</MonoText>
      )}
      <View style={{ flexDirection: 'row', gap: spacing.sm }}>
        <TextInput
          testID={`${testID}-value-input`}
          containerStyle={{ flex: 1 }}
          value={draft}
          mono
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="done"
          placeholder={segmentOp ? 'beta-testers' : 'pro'}
          onChangeText={setDraft}
          onSubmitEditing={addValue}
        />
        <Button
          testID={`${testID}-value-add`}
          label="Add"
          variant="secondary"
          size="md"
          onPress={addValue}
        />
      </View>
    </View>
  );
}
