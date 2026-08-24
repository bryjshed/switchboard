/**
 * Primitive color palette. Raw hex lives HERE and in tokens.ts only —
 * components consume semantic tokens, never these primitives.
 *
 * Accent: signal amber/orange. Contrast (WCAG relative luminance):
 *   amber600 #E8590C on canvas50 #FAFAF9 = 3.43:1  -> fills / large text only
 *   amber700 #C2410C on canvas50 #FAFAF9 = 4.96:1  -> AA small text (light mode)
 *   amber400 #FF922B on ink950  #131312 = 8.32:1   -> AA small text (dark mode)
 *   amber300 #FFA94D on ink950  #131312 = 9.77:1   -> lifted small-text tint (dark)
 */
export const palette = {
  // Accent — signal amber
  amber300: '#FFA94D',
  amber400: '#FF922B',
  amber600: '#E8590C',
  amber700: '#C2410C',

  // Light canvas / dark elevation ladder (dark steps ~+5-8% lightness, never pure black)
  canvas50: '#FAFAF9',
  canvas100: '#F2F1EF',
  white: '#FFFFFF',
  ink950: '#131312', // dark surface.base
  ink920: '#1A1A19', // dark surface.subtle
  ink900: '#1D1D1B', // dark surface.raised
  ink850: '#262624', // dark surface.elevated

  // Light ink ladder
  ink800: '#1B1B19',
  ink500: '#5C5B56',
  ink400: '#8B8A84',

  // Dark ink ladder
  paper100: '#F4F4F2',
  paper400: '#A8A7A1',
  paper600: '#706F6A',

  // Environment identities (badge pairs, never CTAs)
  blue100: '#E7F0FE',
  blue300: '#7DABF8',
  blue700: '#1B5FBF',
  sand100: '#FDF0E0',
  sand300: '#FFB05C',
  sand700: '#9A5B00',
  green100: '#E3F4E8',
  green300: '#5FCE8A',
  green700: '#1E7A3E',

  // Status
  red100: '#FCE9E9',
  red300: '#FF6B6B',
  red700: '#C92A2A',
  gold300: '#FFC078',

  // Hairlines / alpha inks
  inkAlpha08: 'rgba(27, 27, 25, 0.08)',
  inkAlpha13: 'rgba(27, 27, 25, 0.13)',
  inkAlpha24: 'rgba(27, 27, 25, 0.24)',
  inkAlpha45: 'rgba(27, 27, 25, 0.45)',
  whiteAlpha10: 'rgba(255, 255, 255, 0.10)',
  whiteAlpha14: 'rgba(255, 255, 255, 0.14)',
  whiteAlpha26: 'rgba(255, 255, 255, 0.26)',
  blackAlpha60: 'rgba(0, 0, 0, 0.60)',

  // Accent / status alpha washes (dark mode backgrounds)
  amberAlpha14: 'rgba(255, 146, 43, 0.14)',
  amberAlpha40: 'rgba(255, 146, 43, 0.40)',
  amberLightAlpha12: 'rgba(232, 89, 12, 0.12)',
  amberLightAlpha40: 'rgba(232, 89, 12, 0.40)',
  blueAlpha16: 'rgba(76, 139, 245, 0.16)',
  sandAlpha16: 'rgba(255, 146, 43, 0.16)',
  greenAlpha16: 'rgba(60, 190, 110, 0.16)',
  redAlpha14: 'rgba(255, 107, 107, 0.14)',
  goldAlpha14: 'rgba(255, 192, 120, 0.14)',
} as const;
