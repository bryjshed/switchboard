import Feather from '@expo/vector-icons/Feather';
import React, { useMemo, useState } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, View } from 'react-native';

import { spacing, useTheme } from '@shared/theme';
import { Button, Chip, SegmentedControl, Sheet, TextInput } from '@shared/ui';

import { isValidFlagKey, slugifyKey } from '../lib/targeting';
import { useCreateFlagMutation, type FlagMutationScope } from '../mutations/flagMutations';
import type { FlagKind, VariationCreate } from '../types';

export interface CreateFlagSheetProps {
  visible: boolean;
  onClose: () => void;
  scope: FlagMutationScope;
  /** Fired after a successful create so the caller can navigate to the detail. */
  onCreated: (flagKey: string) => void;
  testID?: string;
}

const KIND_OPTIONS: { value: FlagKind; label: string }[] = [
  { value: 'BOOLEAN', label: 'Boolean' },
  { value: 'STRING', label: 'String' },
];

interface DraftVariation extends VariationCreate {
  /** Stable row identity so removing a row never re-keys its siblings. */
  rowId: string;
}

let rowSeq = 0;
const newRow = (): DraftVariation => ({ rowId: `v${++rowSeq}`, value: '', name: '' });

/**
 * Create-flag form. The key auto-slugs from the name until the user edits it,
 * then stops tracking — retyping the name must never clobber a hand-written key.
 */
export function CreateFlagSheet({
  visible,
  onClose,
  scope,
  onCreated,
  testID = 'create-flag',
}: CreateFlagSheetProps) {
  const { tokens, typography } = useTheme();
  const [name, setName] = useState('');
  const [key, setKey] = useState('');
  const [keyEdited, setKeyEdited] = useState(false);
  const [kind, setKind] = useState<FlagKind>('BOOLEAN');
  const [variations, setVariations] = useState<DraftVariation[]>([newRow(), newRow()]);
  const [tagDraft, setTagDraft] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  const createFlag = useCreateFlagMutation(scope);

  const reset = () => {
    setName('');
    setKey('');
    setKeyEdited(false);
    setKind('BOOLEAN');
    setVariations([newRow(), newRow()]);
    setTagDraft('');
    setTags([]);
    setError(null);
  };

  const close = () => {
    reset();
    onClose();
  };

  const onNameChange = (next: string) => {
    setName(next);
    if (!keyEdited) setKey(slugifyKey(next));
  };

  const trimmedVariations = useMemo(
    () => variations.map((v) => ({ ...v, value: v.value.trim(), name: (v.name ?? '').trim() })),
    [variations],
  );

  const variationsValid =
    kind === 'BOOLEAN' ||
    (trimmedVariations.length >= 2 &&
      trimmedVariations.every((v) => v.value.length > 0) &&
      new Set(trimmedVariations.map((v) => v.value)).size === trimmedVariations.length);

  const valid = name.trim().length > 0 && isValidFlagKey(key) && variationsValid;

  const addTag = () => {
    const tag = tagDraft.trim();
    if (!tag || tags.includes(tag)) {
      setTagDraft('');
      return;
    }
    setTags([...tags, tag]);
    setTagDraft('');
  };

  const submit = async () => {
    if (!valid || createFlag.isPending) return;
    setError(null);
    try {
      const created = await createFlag.mutateAsync({
        key,
        name: name.trim(),
        kind,
        tags,
        variations:
          kind === 'STRING'
            ? trimmedVariations.map((v) => ({ value: v.value, name: v.name || undefined }))
            : undefined,
      });
      reset();
      onCreated(created.key);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not create the flag');
    }
  };

  return (
    <Sheet visible={visible} onClose={close} title="New flag" testID={testID}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
        <ScrollView
          style={{ maxHeight: 480 }}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ gap: spacing.md, paddingBottom: spacing.md }}
        >
          <TextInput
            testID={`${testID}-name`}
            label="Name"
            value={name}
            onChangeText={onNameChange}
            placeholder="New checkout"
            autoCapitalize="sentences"
          />
          <TextInput
            testID={`${testID}-key`}
            label="Key"
            value={key}
            mono
            autoCapitalize="none"
            autoCorrect={false}
            onChangeText={(next) => {
              setKeyEdited(true);
              setKey(next);
            }}
            placeholder="new-checkout"
            error={key.length > 0 && !isValidFlagKey(key) ? 'Lowercase letters, digits, dashes' : undefined}
          />

          <View style={{ gap: spacing.xs }}>
            <Text style={[typography.label, { color: tokens.text.secondary }]}>Kind</Text>
            <SegmentedControl
              testID={`${testID}-kind`}
              options={KIND_OPTIONS}
              value={kind}
              onChange={setKind}
            />
          </View>

          {kind === 'STRING' ? (
            <View style={{ gap: spacing.sm }}>
              <Text style={[typography.label, { color: tokens.text.secondary }]}>
                Variations (at least 2)
              </Text>
              {variations.map((row, index) => (
                <View key={row.rowId} style={{ flexDirection: 'row', gap: spacing.sm }}>
                  <TextInput
                    testID={`${testID}-variation-value-${index}`}
                    containerStyle={{ flex: 1 }}
                    value={row.value}
                    mono
                    autoCapitalize="none"
                    placeholder="value"
                    onChangeText={(next) =>
                      setVariations((rows) =>
                        rows.map((r) => (r.rowId === row.rowId ? { ...r, value: next } : r)),
                      )
                    }
                  />
                  <TextInput
                    testID={`${testID}-variation-name-${index}`}
                    containerStyle={{ flex: 1 }}
                    value={row.name ?? ''}
                    placeholder="label (optional)"
                    onChangeText={(next) =>
                      setVariations((rows) =>
                        rows.map((r) => (r.rowId === row.rowId ? { ...r, name: next } : r)),
                      )
                    }
                  />
                  <Pressable
                    testID={`${testID}-variation-remove-${index}`}
                    accessibilityRole="button"
                    accessibilityLabel={`Remove variation ${index + 1}`}
                    disabled={variations.length <= 2}
                    hitSlop={8}
                    onPress={() =>
                      setVariations((rows) => rows.filter((r) => r.rowId !== row.rowId))
                    }
                    style={{
                      justifyContent: 'center',
                      opacity: variations.length <= 2 ? 0.3 : 1,
                    }}
                  >
                    <Feather name="minus-circle" size={18} color={tokens.text.tertiary} />
                  </Pressable>
                </View>
              ))}
              <Button
                testID={`${testID}-variation-add`}
                label="Add variation"
                variant="secondary"
                size="sm"
                onPress={() => setVariations((rows) => [...rows, newRow()])}
              />
            </View>
          ) : null}

          <View style={{ gap: spacing.sm }}>
            <TextInput
              testID={`${testID}-tag`}
              label="Tags"
              value={tagDraft}
              onChangeText={setTagDraft}
              onSubmitEditing={addTag}
              autoCapitalize="none"
              returnKeyType="done"
              placeholder="checkout"
            />
            {tags.length > 0 ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
                {tags.map((tag) => (
                  <Chip
                    key={tag}
                    testID={`${testID}-tag-${tag}`}
                    label={`${tag}  ×`}
                    selected
                    onPress={() => setTags(tags.filter((t) => t !== tag))}
                  />
                ))}
              </View>
            ) : null}
          </View>

          {error ? (
            <Text style={[typography.bodySm, { color: tokens.status.error }]}>{error}</Text>
          ) : null}

          <Button
            testID={`${testID}-submit`}
            label="Create flag"
            disabled={!valid}
            loading={createFlag.isPending}
            onPress={submit}
          />
        </ScrollView>
      </KeyboardAvoidingView>
    </Sheet>
  );
}
