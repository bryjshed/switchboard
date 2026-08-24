import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
} from '@expo-google-fonts/inter';
import {
  JetBrainsMono_400Regular,
  JetBrainsMono_500Medium,
} from '@expo-google-fonts/jetbrains-mono';
import {
  SpaceGrotesk_600SemiBold,
  SpaceGrotesk_700Bold,
} from '@expo-google-fonts/space-grotesk';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useFonts } from 'expo-font';
import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import React, { useEffect } from 'react';

import { useAuthStore } from '@features/auth/stores/authStore';
import { buildNavigationTheme, useTheme } from '@shared/theme';
import { ErrorBoundary } from '@shared/ui';

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 15_000,
      refetchOnWindowFocus: false,
    },
  },
});

export default function RootLayout() {
  const { tokens, isDark } = useTheme();
  const authStatus = useAuthStore((s) => s.status);
  const bootstrap = useAuthStore((s) => s.bootstrap);

  const [fontsLoaded] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
    SpaceGrotesk_600SemiBold,
    SpaceGrotesk_700Bold,
    JetBrainsMono_400Regular,
    JetBrainsMono_500Medium,
  });

  useEffect(() => {
    void bootstrap();
  }, [bootstrap]);

  const ready = fontsLoaded && authStatus !== 'loading';

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  // Tri-state gate: while loading, stay on the native splash (render nothing).
  if (!ready) return null;

  const navTheme = buildNavigationTheme(isDark ? DarkTheme : DefaultTheme, tokens);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider value={navTheme}>
        <ErrorBoundary>
          <StatusBar style={isDark ? 'light' : 'dark'} />
          <Stack
            screenOptions={{
              headerShown: false,
              contentStyle: { backgroundColor: tokens.surface.base },
            }}
          >
            {/*
             * Auth gate. Guards only ever demote when the auth store says
             * 'unauthenticated' (explicit sign-out or 401) — a failed /me
             * fetch keeps the session (see authStore.bootstrap).
             */}
            <Stack.Protected guard={authStatus === 'authenticated'}>
              <Stack.Screen name="(tabs)" />
              <Stack.Screen name="flag/[flagKey]/index" />
              <Stack.Screen name="flag/[flagKey]/targeting" />
              <Stack.Screen name="flag/[flagKey]/history" />
              <Stack.Screen name="flag/[flagKey]/monitor" />
              <Stack.Screen name="ai/proposals" />
              <Stack.Screen name="ai/proposal/[id]" />
              <Stack.Screen name="sdk-keys" />
              <Stack.Screen
                name="ai/create"
                options={{ presentation: 'modal', headerShown: false }}
              />
              <Stack.Screen
                name="upgrade"
                options={{ presentation: 'modal', headerShown: false }}
              />
            </Stack.Protected>
            <Stack.Protected guard={authStatus !== 'authenticated'}>
              <Stack.Screen name="(auth)" />
            </Stack.Protected>
          </Stack>
        </ErrorBoundary>
      </ThemeProvider>
    </QueryClientProvider>
  );
}
