import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Text, View } from 'react-native';

import { envLabel, envTone } from '@shared/lib/env';
import { radius, spacing, useTheme } from '@shared/theme';
import { Badge, Card, MonoText } from '@shared/ui';
import type { FlagChangeDiff, FlagDetailResponse } from '@shared/api/types';

import { summarizeDiff, type DiffLine, type DiffSection, type DiffTone } from '../lib/diffSummary';

export interface DiffPreviewProps {
  diff: FlagChangeDiff;
  /** The flag as it exists today; supplies the "before" side of every line. */
  flag?: FlagDetailResponse;
  /** True while the flag is still loading, so "before" is absent but coming. */
  flagLoading?: boolean;
  testID?: string;
}

/**
 * Renders a typed FlagChangeDiff as a change summary a human can approve.
 *
 * Never JSON. Every line is prose produced by lib/diffSummary (pure and
 * unit-tested); this component only lays it out and tints it. Where the current
 * value is known it shows before → after so nothing has to be inferred.
 */
export function DiffPreview({ diff, flag, flagLoading = false, testID = 'diff-preview' }: DiffPreviewProps) {
  const { tokens, typography } = useTheme();
  const summary = summarizeDiff(diff, { flag });

  return (
    <View testID={testID} style={{ gap: spacing.md }}>
      <View style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Badge testID={`${testID}-kind`} label={summary.kindLabel} tone="accent" />
          <MonoText testID={`${testID}-flag-key`} style={{ flex: 1 }} numberOfLines={1}>
            {summary.flagKey}
          </MonoText>
        </View>
        <Text testID={`${testID}-headline`} style={[typography.subtitle, { color: tokens.text.primary }]}>
          {summary.headline}
        </Text>
        {!flag && !flagLoading && summary.kind !== 'FLAG_CREATE' ? (
          <Text style={[typography.caption, { color: tokens.text.tertiary }]}>
            Current values are unavailable, so only the proposed side is shown.
          </Text>
        ) : null}
      </View>

      {summary.hasChanges ? (
        summary.sections.map((section, i) => (
          <SectionCard key={`${section.title}-${i}`} section={section} testID={`${testID}-section-${i}`} />
        ))
      ) : (
        <Card testID={`${testID}-no-changes`}>
          <Text style={[typography.bodySm, { color: tokens.text.secondary }]}>
            This proposal does not change anything that is currently set.
          </Text>
        </Card>
      )}
    </View>
  );
}

function SectionCard({ section, testID }: { section: DiffSection; testID: string }) {
  const { tokens, typography } = useTheme();
  const isEnv = !!section.envKey;
  return (
    <Card testID={testID} style={{ gap: spacing.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        {isEnv ? (
          <Badge label={envLabel(section.envKey as string)} tone={envTone(section.envKey as string)} />
        ) : (
          <Text style={[typography.label, { color: tokens.text.tertiary }]}>
            {section.title.toUpperCase()}
          </Text>
        )}
      </View>
      {section.lines.map((line, i) => (
        <DiffLineRow key={`${line.label}-${i}`} line={line} testID={`${testID}-line-${i}`} />
      ))}
      {section.checklist?.map((item, i) => (
        <View
          key={`${item}-${i}`}
          testID={`${testID}-check-${i}`}
          style={{ flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' }}
        >
          <Feather name="square" size={16} color={tokens.text.tertiary} style={{ marginTop: 2 }} />
          <Text style={[typography.bodySm, { color: tokens.text.primary, flex: 1 }]}>{item}</Text>
        </View>
      ))}
    </Card>
  );
}

function DiffLineRow({ line, testID }: { line: DiffLine; testID: string }) {
  const { tokens, typography } = useTheme();
  const toneColors = (tone: DiffTone): { ink: string; bg: string } => {
    switch (tone) {
      case 'added':
        return { ink: tokens.status.success, bg: tokens.status.successBg };
      case 'removed':
        return { ink: tokens.status.error, bg: tokens.status.errorBg };
      default:
        return { ink: tokens.text.primary, bg: tokens.surface.subtle };
    }
  };
  const colors = toneColors(line.tone);

  return (
    <View testID={testID} style={{ gap: spacing.xs }}>
      <Text style={[typography.caption, { color: tokens.text.tertiary }]}>{line.label}</Text>
      <View style={{ flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: spacing.xs }}>
        {line.before ? (
          <>
            <Pill
              testID={`${testID}-before`}
              text={line.before}
              ink={tokens.text.secondary}
              bg={tokens.surface.subtle}
            />
            <Feather name="arrow-right" size={12} color={tokens.text.tertiary} />
          </>
        ) : null}
        {line.after ? (
          <Pill testID={`${testID}-after`} text={line.after} ink={colors.ink} bg={colors.bg} />
        ) : (
          <Pill
            testID={`${testID}-after`}
            text="removed"
            ink={tokens.status.error}
            bg={tokens.status.errorBg}
          />
        )}
      </View>
    </View>
  );
}

function Pill({ text, ink, bg, testID }: { text: string; ink: string; bg: string; testID: string }) {
  const { typography } = useTheme();
  return (
    <View
      testID={testID}
      style={{
        backgroundColor: bg,
        borderRadius: radius.sm,
        paddingHorizontal: spacing.sm,
        paddingVertical: spacing.xs,
        flexShrink: 1,
      }}
    >
      <Text style={[typography.bodySm, { color: ink }]}>{text}</Text>
    </View>
  );
}
