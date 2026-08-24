import Feather from '@expo/vector-icons/Feather';
import { Tabs } from 'expo-router';
import React from 'react';

import { useTheme } from '@shared/theme';

export default function TabsLayout() {
  const { tokens, typography } = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: tokens.accent.primary,
        tabBarInactiveTintColor: tokens.text.tertiary,
        tabBarStyle: {
          backgroundColor: tokens.surface.base,
          borderTopColor: tokens.border.subtle,
        },
        tabBarLabelStyle: { fontFamily: typography.label.fontFamily, fontSize: 10 },
      }}
    >
      <Tabs.Screen
        name="flags"
        options={{
          title: 'Flags',
          tabBarIcon: ({ color, size }) => <Feather name="toggle-right" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="monitor"
        options={{
          title: 'Monitor',
          tabBarIcon: ({ color, size }) => <Feather name="activity" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="activity"
        options={{
          title: 'Activity',
          tabBarIcon: ({ color, size }) => <Feather name="list" size={size} color={color} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Settings',
          tabBarIcon: ({ color, size }) => <Feather name="settings" size={size} color={color} />,
        }}
      />
    </Tabs>
  );
}
