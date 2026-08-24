import Feather from '@expo/vector-icons/Feather';
import React from 'react';
import { ScrollView, Text, View } from 'react-native';

import { spacing, useTheme } from '@shared/theme';
import { Chip, MonoText, PressableScale, Sheet } from '@shared/ui';

import { envLabel } from '@shared/lib/env';
import { useActiveContext } from '../hooks/useActiveContext';
import { useActiveOrgStore } from '../stores/activeOrgStore';

export interface OrgProjectSwitcherProps {
  visible: boolean;
  onClose: () => void;
  testID?: string;
}

interface RowProps {
  title: string;
  subtitle?: string;
  mono?: boolean;
  selected: boolean;
  onPress: () => void;
  testID: string;
}

function SelectRow({ title, subtitle, mono, selected, onPress, testID }: RowProps) {
  const { tokens, typography } = useTheme();
  return (
    <PressableScale
      testID={testID}
      onPress={onPress}
      hapticKind="selection"
      accessibilityRole="button"
      accessibilityState={{ selected }}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        paddingVertical: spacing.md,
        paddingHorizontal: spacing.md,
        borderRadius: 10,
        backgroundColor: selected ? tokens.accent.subtle : 'transparent',
      }}
    >
      <View style={{ flex: 1 }}>
        <Text style={[typography.subtitle, { color: tokens.text.primary }]} numberOfLines={1}>
          {title}
        </Text>
        {subtitle ? (
          mono ? (
            <MonoText size="sm" style={{ marginTop: spacing.xxs }} numberOfLines={1}>
              {subtitle}
            </MonoText>
          ) : (
            <Text
              style={[typography.bodySm, { color: tokens.text.secondary, marginTop: spacing.xxs }]}
              numberOfLines={1}
            >
              {subtitle}
            </Text>
          )
        ) : null}
      </View>
      {selected ? <Feather name="check" size={16} color={tokens.accent.primaryDark} /> : null}
    </PressableScale>
  );
}

/**
 * Org → project → environment switcher. Reads the live context so a stale
 * persisted selection self-heals; every tap writes straight to the persisted
 * store, which the rest of the app reads through useActiveContext.
 */
export function OrgProjectSwitcher({
  visible,
  onClose,
  testID = 'org-switcher',
}: OrgProjectSwitcherProps) {
  const { tokens, typography } = useTheme();
  const { memberships, orgId, projects, projectId, environments, envKey } = useActiveContext();
  const setActiveOrg = useActiveOrgStore((s) => s.setActiveOrg);
  const setActiveProject = useActiveOrgStore((s) => s.setActiveProject);
  const setActiveEnvKey = useActiveOrgStore((s) => s.setActiveEnvKey);

  const sectionLabel = (text: string) => (
    <Text
      style={[
        typography.label,
        { color: tokens.text.tertiary, marginTop: spacing.md, marginBottom: spacing.xs },
      ]}
    >
      {text}
    </Text>
  );

  return (
    <Sheet visible={visible} onClose={onClose} title="Switch context" testID={testID}>
      <ScrollView style={{ maxHeight: 460 }} showsVerticalScrollIndicator={false}>
        {sectionLabel('ORGANIZATION')}
        {memberships.map((m) => (
          <SelectRow
            key={m.orgId}
            testID={`${testID}-org-${m.orgSlug}`}
            title={m.orgName}
            subtitle={`${m.orgSlug} · ${m.role.toLowerCase()}`}
            selected={m.orgId === orgId}
            onPress={() => setActiveOrg(m.orgId)}
          />
        ))}

        {sectionLabel('PROJECT')}
        {projects.length === 0 ? (
          <Text style={[typography.bodySm, { color: tokens.text.secondary, padding: spacing.md }]}>
            This org has no projects yet.
          </Text>
        ) : (
          projects.map((p) => (
            <SelectRow
              key={p.id}
              testID={`${testID}-project-${p.key}`}
              title={p.name}
              subtitle={p.key}
              mono
              selected={p.id === projectId}
              onPress={() => setActiveProject(p.id)}
            />
          ))
        )}

        {sectionLabel('ENVIRONMENT')}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
          {environments.map((env) => (
            <Chip
              key={env.id}
              testID={`${testID}-env-${env.key}`}
              label={envLabel(env.key)}
              selected={env.key === envKey}
              onPress={() => setActiveEnvKey(env.key)}
            />
          ))}
        </View>
      </ScrollView>
    </Sheet>
  );
}
