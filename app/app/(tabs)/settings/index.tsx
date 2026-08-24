import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import React, { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

import { AiSettingsSection } from '@features/ai/components/AiSettingsSection';
import { useAuthStore } from '@features/auth/stores/authStore';
import { OrgProjectSwitcher } from '@features/orgs/components/OrgProjectSwitcher';
import { useActiveContext } from '@features/orgs/hooks/useActiveContext';
import { orgMembersOptions } from '@features/orgs/queries/orgQueries';
import { useActiveOrgStore } from '@features/orgs/stores/activeOrgStore';
import { envLabel } from '@shared/lib/env';
import { spacing, useTheme, useThemeMode, type ThemeMode } from '@shared/theme';
import {
  Badge,
  Button,
  Card,
  ListItem,
  MonoText,
  PageHeader,
  ScreenView,
  SegmentedControl,
  Skeleton,
} from '@shared/ui';

const MODE_OPTIONS: { value: ThemeMode; label: string }[] = [
  { value: 'system', label: 'System' },
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
];

export default function SettingsScreen() {
  const { tokens, typography } = useTheme();
  const router = useRouter();
  const client = useQueryClient();
  const mode = useThemeMode((s) => s.mode);
  const setMode = useThemeMode((s) => s.setMode);
  const user = useAuthStore((s) => s.user);
  const signOut = useAuthStore((s) => s.signOut);
  const resetActiveOrg = useActiveOrgStore((s) => s.reset);
  const { userId, org, project, envKey } = useActiveContext();
  const membersQuery = useQuery(orgMembersOptions(userId, org?.orgId));
  const [switcherVisible, setSwitcherVisible] = useState(false);

  const onSignOut = () => {
    // Drop every user-scoped cache and selection before the gate flips, so the
    // next account never renders a frame of the previous one's data.
    resetActiveOrg();
    client.clear();
    signOut();
  };

  const sectionLabel = (text: string) => (
    <Text style={[typography.label, { color: tokens.text.tertiary, marginBottom: spacing.sm }]}>
      {text}
    </Text>
  );

  return (
    <ScreenView testID="settings-screen">
      <PageHeader title="Settings" />
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.xxl,
          gap: spacing.xl,
        }}
      >
        <View>
          {sectionLabel('ACCOUNT')}
          <Card padded={false}>
            <ListItem
              title={user?.email ?? 'Signed in'}
              subtitle={user?.displayName ?? 'Switchboard account'}
              testID="settings-account"
            />
          </Card>
        </View>

        <View>
          {sectionLabel('ORGANIZATION')}
          <Card padded={false}>
            <ListItem
              title={org?.orgName ?? 'No organization'}
              subtitle={org ? `${org.orgSlug} · ${org.role.toLowerCase()}` : undefined}
              right={org ? <Badge label={org.role} tone="accent" /> : undefined}
              testID="settings-org"
            />
            {membersQuery.isLoading ? (
              <View style={{ padding: spacing.lg, gap: spacing.sm }}>
                <Skeleton height={16} width="60%" />
                <Skeleton height={16} width="45%" />
              </View>
            ) : (
              (membersQuery.data ?? []).map((member) => (
                <ListItem
                  key={member.userId}
                  testID={`settings-member-${member.userId}`}
                  title={member.email}
                  subtitle={member.role === 'OWNER' ? 'Owner' : 'Member'}
                  style={{ paddingVertical: spacing.sm }}
                />
              ))
            )}
          </Card>
        </View>

        <View>
          {sectionLabel('ACTIVE CONTEXT')}
          <Card padded={false}>
            <ListItem
              title={project?.name ?? 'No project'}
              subtitle={project?.key}
              right={
                envKey ? (
                  <Badge
                    label={envLabel(envKey)}
                    tone={
                      envKey === 'dev' || envKey === 'staging' || envKey === 'production'
                        ? envKey
                        : 'neutral'
                    }
                  />
                ) : undefined
              }
              chevron
              onPress={() => setSwitcherVisible(true)}
              testID="settings-switch-context"
            />
            <ListItem
              title="SDK keys"
              subtitle="Create and revoke keys per environment"
              chevron
              onPress={() => router.push('/sdk-keys')}
              testID="settings-sdk-keys"
            />
          </Card>
        </View>

        <View>
          {sectionLabel('AI')}
          <AiSettingsSection userId={userId} orgId={org?.orgId} role={org?.role} />
        </View>

        <View>
          {sectionLabel('APPEARANCE')}
          <SegmentedControl
            testID="settings-theme"
            options={MODE_OPTIONS}
            value={mode}
            onChange={setMode}
          />
        </View>

        <View style={{ gap: spacing.sm }}>
          <Button
            testID="settings-sign-out"
            label="Sign out"
            variant="secondary"
            onPress={onSignOut}
          />
          <MonoText size="sm" style={{ textAlign: 'center' }}>
            switchboard · local
          </MonoText>
        </View>
      </ScrollView>

      <OrgProjectSwitcher visible={switcherVisible} onClose={() => setSwitcherVisible(false)} />
    </ScreenView>
  );
}
