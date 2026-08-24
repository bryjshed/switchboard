import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { Text, View } from 'react-native';

import { relativeTime } from '@shared/lib/time';
import { spacing, useTheme } from '@shared/theme';
import { Badge, Card, MonoText, PressableScale } from '@shared/ui';
import type { AiProposalResponse } from '@shared/api/types';

import { proposalKindLabel, proposalStatusLabel, proposalStatusTone } from '../lib/diffSummary';

export interface ProposalRowProps {
  proposal: AiProposalResponse;
  onPress: () => void;
  testID?: string;
}

/**
 * One line of AI activity: what kind of change, where it landed, and who asked
 * for it. `switchboard-monitor` as the author is how healing and optimizing
 * show up, which is the whole point of putting this on the Monitor tab.
 */
export function ProposalRow({ proposal, onPress, testID }: ProposalRowProps) {
  const { tokens, typography } = useTheme();
  const id = testID ?? `proposal-${proposal.id}`;
  const automated = proposal.createdBy === 'switchboard-monitor';

  return (
    <PressableScale
      testID={id}
      onPress={onPress}
      hapticKind="selection"
      accessibilityRole="button"
      accessibilityLabel={`${proposalKindLabel(proposal.kind)} ${proposal.diff.flagKey}, ${proposalStatusLabel(proposal.status)}`}
    >
      <Card style={{ gap: spacing.sm }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Badge
            testID={`${id}-kind`}
            label={proposalKindLabel(proposal.kind)}
            tone="neutral"
          />
          <Badge
            testID={`${id}-status`}
            label={proposalStatusLabel(proposal.status)}
            tone={proposalStatusTone(proposal.status)}
          />
          <View style={{ flex: 1 }} />
          <Text style={[typography.caption, { color: tokens.text.tertiary }]}>
            {relativeTime(proposal.createdAt)}
          </Text>
          <Feather name="chevron-right" size={14} color={tokens.text.tertiary} />
        </View>
        <MonoText testID={`${id}-flag`} numberOfLines={1}>
          {proposal.diff.flagKey}
        </MonoText>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.xs }}>
          <Feather
            name={automated ? 'cpu' : 'user'}
            size={12}
            color={tokens.text.tertiary}
          />
          <Text
            style={[typography.caption, { color: tokens.text.tertiary, flex: 1 }]}
            numberOfLines={1}
          >
            {automated ? 'Switchboard monitor' : proposal.createdBy}
            {proposal.appliedVersion ? ` · v${proposal.appliedVersion}` : ''}
          </Text>
        </View>
      </Card>
    </PressableScale>
  );
}
