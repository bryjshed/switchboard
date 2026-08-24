import type { TextStyle, ViewStyle } from 'react-native';

import { palette } from './palette';

/** One env identity = a badge pair (bg + ink). Badge/pill use only — never CTAs. */
export interface EnvTint {
  bg: string;
  ink: string;
}

export interface ThemeTokens {
  mode: 'light' | 'dark';
  surface: {
    base: string;
    raised: string;
    elevated: string;
    subtle: string;
    overlay: string;
  };
  text: {
    primary: string;
    secondary: string;
    tertiary: string;
    onAccent: string;
  };
  accent: {
    /** Fills and large elements. NOT AA for small text in light mode — use primaryDark there. */
    primary: string;
    /** Contrast-safe accent for small text (>= 4.5:1 on surface.base in this mode). */
    primaryDark: string;
    /** Accent-tinted background wash. */
    subtle: string;
    /** Mid-strength accent (track fills, secondary emphasis). */
    muted: string;
  };
  border: {
    subtle: string;
    default: string;
    strong: string;
  };
  status: {
    error: string;
    errorBg: string;
    success: string;
    successBg: string;
    warning: string;
    warningBg: string;
  };
  tints: {
    dev: EnvTint;
    staging: EnvTint;
    production: EnvTint;
  };
  /** Single floating-shadow tier. Dark mode swaps shadow for a hairline border. */
  floatingShadow: ViewStyle;
}

export const lightTokens: ThemeTokens = {
  mode: 'light',
  surface: {
    base: palette.canvas50,
    raised: palette.white,
    elevated: palette.white,
    subtle: palette.canvas100,
    overlay: palette.inkAlpha45,
  },
  text: {
    primary: palette.ink800,
    secondary: palette.ink500,
    tertiary: palette.ink400,
    onAccent: palette.white,
  },
  accent: {
    primary: palette.amber600,
    primaryDark: palette.amber700,
    subtle: palette.amberLightAlpha12,
    muted: palette.amberLightAlpha40,
  },
  border: {
    subtle: palette.inkAlpha08,
    default: palette.inkAlpha13,
    strong: palette.inkAlpha24,
  },
  status: {
    error: palette.red700,
    errorBg: palette.red100,
    success: palette.green700,
    successBg: palette.green100,
    warning: palette.sand700,
    warningBg: palette.sand100,
  },
  tints: {
    dev: { bg: palette.blue100, ink: palette.blue700 },
    staging: { bg: palette.sand100, ink: palette.sand700 },
    production: { bg: palette.green100, ink: palette.green700 },
  },
  floatingShadow: {
    shadowColor: palette.ink800,
    shadowOpacity: 0.1,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 6 },
    elevation: 6,
  },
};

export const darkTokens: ThemeTokens = {
  mode: 'dark',
  surface: {
    base: palette.ink950,
    raised: palette.ink900,
    elevated: palette.ink850,
    subtle: palette.ink920,
    overlay: palette.blackAlpha60,
  },
  text: {
    primary: palette.paper100,
    secondary: palette.paper400,
    tertiary: palette.paper600,
    onAccent: palette.ink800,
  },
  accent: {
    primary: palette.amber400,
    primaryDark: palette.amber300,
    subtle: palette.amberAlpha14,
    muted: palette.amberAlpha40,
  },
  border: {
    subtle: palette.whiteAlpha10,
    default: palette.whiteAlpha14,
    strong: palette.whiteAlpha26,
  },
  status: {
    error: palette.red300,
    errorBg: palette.redAlpha14,
    success: palette.green300,
    successBg: palette.greenAlpha16,
    warning: palette.gold300,
    warningBg: palette.goldAlpha14,
  },
  tints: {
    dev: { bg: palette.blueAlpha16, ink: palette.blue300 },
    staging: { bg: palette.sandAlpha16, ink: palette.sand300 },
    production: { bg: palette.greenAlpha16, ink: palette.green300 },
  },
  floatingShadow: {
    borderWidth: 1,
    borderColor: palette.whiteAlpha10,
  },
};

export const radius = {
  sm: 10,
  md: 14,
  lg: 24,
  pill: 999,
} as const;

/** 4-based spacing scale. */
export const spacing = {
  xxs: 2,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 40,
} as const;

/**
 * Font families. Display (Space Grotesk) is for SANCTIONED SLOTS ONLY:
 * screen titles and big stat numbers. UI text is Inter; flag/context keys are
 * JetBrains Mono. No raw fontFamily outside this file and the font-loading layout.
 */
const fonts = {
  displayBold: 'SpaceGrotesk_700Bold',
  displaySemiBold: 'SpaceGrotesk_600SemiBold',
  uiRegular: 'Inter_400Regular',
  uiMedium: 'Inter_500Medium',
  uiSemiBold: 'Inter_600SemiBold',
  uiBold: 'Inter_700Bold',
  monoRegular: 'JetBrainsMono_400Regular',
  monoMedium: 'JetBrainsMono_500Medium',
} as const;

export type TypeSlot =
  | 'display'
  | 'headline'
  | 'pageTitle'
  | 'stat'
  | 'title'
  | 'subtitle'
  | 'body'
  | 'bodySm'
  | 'label'
  | 'caption'
  | 'mono'
  | 'monoSm';

export const typography: Record<TypeSlot, TextStyle> = {
  display: { fontFamily: fonts.displayBold, fontSize: 34, lineHeight: 40, letterSpacing: -0.6 },
  headline: { fontFamily: fonts.displaySemiBold, fontSize: 26, lineHeight: 32, letterSpacing: -0.4 },
  pageTitle: { fontFamily: fonts.displayBold, fontSize: 22, lineHeight: 28, letterSpacing: -0.3 },
  stat: { fontFamily: fonts.displayBold, fontSize: 30, lineHeight: 34, letterSpacing: -0.4 },
  title: { fontFamily: fonts.uiSemiBold, fontSize: 17, lineHeight: 22 },
  subtitle: { fontFamily: fonts.uiMedium, fontSize: 15, lineHeight: 20 },
  body: { fontFamily: fonts.uiRegular, fontSize: 15, lineHeight: 22 },
  bodySm: { fontFamily: fonts.uiRegular, fontSize: 13, lineHeight: 18 },
  label: { fontFamily: fonts.uiSemiBold, fontSize: 13, lineHeight: 16, letterSpacing: 0.1 },
  caption: { fontFamily: fonts.uiRegular, fontSize: 12, lineHeight: 16 },
  mono: { fontFamily: fonts.monoRegular, fontSize: 13, lineHeight: 18 },
  monoSm: { fontFamily: fonts.monoRegular, fontSize: 11, lineHeight: 14, letterSpacing: 0.1 },
};
