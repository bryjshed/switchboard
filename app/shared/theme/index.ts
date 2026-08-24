import { useColorScheme } from 'react-native';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { mmkvStateStorage } from '../storage';
import { darkTokens, lightTokens, radius, spacing, typography } from './tokens';
import type { ThemeTokens } from './tokens';

export { darkTokens, lightTokens, radius, spacing, typography } from './tokens';
export type { EnvTint, ThemeTokens, TypeSlot } from './tokens';
export { palette } from './palette';

export type ThemeMode = 'system' | 'light' | 'dark';

interface ThemeModeState {
  mode: ThemeMode;
  setMode: (mode: ThemeMode) => void;
}

/**
 * Persisted mode preference. MMKV is synchronous, so the store hydrates
 * before first render — no wrong-theme flash at launch.
 */
export const useThemeMode = create<ThemeModeState>()(
  persist(
    (set) => ({
      mode: 'system',
      setMode: (mode) => set({ mode }),
    }),
    {
      name: 'theme-mode',
      storage: createJSONStorage(() => mmkvStateStorage),
    },
  ),
);

export function resolveTokens(mode: ThemeMode, systemScheme: 'light' | 'dark'): ThemeTokens {
  const resolved = mode === 'system' ? systemScheme : mode;
  return resolved === 'dark' ? darkTokens : lightTokens;
}

export interface Theme {
  tokens: ThemeTokens;
  radius: typeof radius;
  spacing: typeof spacing;
  typography: typeof typography;
  isDark: boolean;
}

/**
 * Resolves the persisted mode against useColorScheme() directly in the
 * consuming component — no effect-synced copy that can lag a scheme change.
 */
export function useTheme(): Theme {
  const mode = useThemeMode((s) => s.mode);
  const scheme = useColorScheme();
  const tokens = resolveTokens(mode, scheme === 'dark' ? 'dark' : 'light');
  return { tokens, radius, spacing, typography, isDark: tokens.mode === 'dark' };
}

/**
 * React Navigation theme (via expo-router's ThemeProvider) built from tokens,
 * so native chrome (headers, tab bar background fallback, screen background)
 * is themed and dark navigation transitions never white-flash.
 */
export function buildNavigationTheme<T extends { colors: object; dark: boolean }>(
  base: T,
  tokens: ThemeTokens,
): T {
  return {
    ...base,
    dark: tokens.mode === 'dark',
    colors: {
      ...base.colors,
      primary: tokens.accent.primary,
      background: tokens.surface.base,
      card: tokens.surface.base,
      text: tokens.text.primary,
      border: tokens.border.subtle,
      notification: tokens.accent.primary,
    },
  };
}
