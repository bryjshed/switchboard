import { darkTokens, lightTokens, radius, typography } from '@shared/theme';

/** WCAG relative luminance of a #rrggbb hex. */
function luminance(hex: string): number {
  const c = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

describe('accent tokens', () => {
  it('uses signal amber: #E8590C light / #FF922B dark', () => {
    expect(lightTokens.accent.primary).toBe('#E8590C');
    expect(darkTokens.accent.primary).toBe('#FF922B');
  });

  it('keeps contrast-safe small-text accents per mode', () => {
    expect(lightTokens.accent.primaryDark).toBe('#C2410C');
    expect(darkTokens.accent.primaryDark).toBe('#FFA94D');
  });
});

describe('surfaces', () => {
  it('light canvas is #FAFAF9', () => {
    expect(lightTokens.surface.base).toBe('#FAFAF9');
  });

  it('dark base is #131312-class, not pure black', () => {
    expect(darkTokens.surface.base).toBe('#131312');
    expect(darkTokens.surface.base).not.toBe('#000000');
  });

  it('dark elevation ladder rises in luminance: base < subtle < raised < elevated', () => {
    const { base, subtle, raised, elevated } = darkTokens.surface;
    const [lBase, lSubtle, lRaised, lElevated] = [base, subtle, raised, elevated].map(luminance);
    expect(lSubtle).toBeGreaterThan(lBase);
    expect(lRaised).toBeGreaterThan(lSubtle);
    expect(lElevated).toBeGreaterThan(lRaised);
  });
});

describe('radius scale', () => {
  it('is {sm:10, md:14, lg:24, pill:999}', () => {
    expect(radius).toEqual({ sm: 10, md: 14, lg: 24, pill: 999 });
  });
});

describe('typography slots', () => {
  it('display font (Space Grotesk) only in sanctioned slots', () => {
    const display = ['display', 'headline', 'pageTitle', 'stat'] as const;
    for (const slot of display) {
      expect(typography[slot].fontFamily).toMatch(/^SpaceGrotesk_/);
    }
  });

  it('UI text is Inter', () => {
    const ui = ['title', 'subtitle', 'body', 'bodySm', 'label', 'caption'] as const;
    for (const slot of ui) {
      expect(typography[slot].fontFamily).toMatch(/^Inter_/);
    }
  });

  it('mono slots are JetBrains Mono', () => {
    expect(typography.mono.fontFamily).toMatch(/^JetBrainsMono_/);
    expect(typography.monoSm.fontFamily).toMatch(/^JetBrainsMono_/);
  });
});
