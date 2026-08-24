import { darkTokens, lightTokens } from '@shared/theme';
import {
  assignVariantColors,
  hashSlot,
  variantColor,
  variantPalette,
  variantSlot,
  VARIANT_PALETTE_SIZE,
} from '@features/ai/lib/variantPalette';

const A = '4b738df0-47db-41a6-9ed5-4a9d98dd5e05';
const B = 'fa144bb1-85aa-41e7-bb80-22bb662aa16e';
const C = '016bfde3-4203-4a4c-bbc3-646499420b2c';

describe('variantPalette', () => {
  it('draws every color from semantic tokens, never a raw literal', () => {
    const light = variantPalette(lightTokens);
    const dark = variantPalette(darkTokens);
    const lightTokenValues = [
      lightTokens.tints.dev.ink,
      lightTokens.accent.primaryDark,
      lightTokens.tints.production.ink,
      lightTokens.tints.staging.ink,
      lightTokens.text.secondary,
    ];
    expect(light).toEqual(lightTokenValues);
    // The same slots re-derive per theme, so nothing is hardcoded for one mode.
    expect(dark).not.toEqual(light);
    expect(dark).toHaveLength(light.length);
  });

  it('does not paint every variant with the accent', () => {
    const palette = variantPalette(lightTokens);
    const accentUses = palette.filter((c) => c === lightTokens.accent.primaryDark);
    expect(accentUses).toHaveLength(1);
  });

  it('gives distinct colors to distinct variants up to the palette length', () => {
    const ids = [A, B, C, 'd', 'e'];
    const colors = assignVariantColors(lightTokens, ids);
    expect(new Set(Object.values(colors)).size).toBe(VARIANT_PALETTE_SIZE);
  });
});

describe('determinism', () => {
  it('assigns the same colors for the same input, every call', () => {
    expect(assignVariantColors(lightTokens, [A, B])).toEqual(
      assignVariantColors(lightTokens, [A, B]),
    );
    expect(variantColor(lightTokens, A, [A, B])).toBe(variantColor(lightTokens, A, [A, B]));
  });

  it('hashes an unordered id to a stable slot inside the palette', () => {
    expect(hashSlot(A)).toBe(hashSlot(A));
    for (const id of [A, B, C, '', 'x']) {
      expect(hashSlot(id)).toBeGreaterThanOrEqual(0);
      expect(hashSlot(id)).toBeLessThan(VARIANT_PALETTE_SIZE);
    }
  });

  it('prefers the given order over the hash so a known set never collides', () => {
    expect(variantSlot(A, [A, B])).toBe(0);
    expect(variantSlot(B, [A, B])).toBe(1);
    // Unknown id still resolves, via the hash.
    expect(variantSlot(C, [A, B])).toBe(hashSlot(C));
  });

  it('cycles rather than running out on a long variant list', () => {
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const colors = assignVariantColors(lightTokens, ids);
    expect(colors.f).toBe(colors.a);
  });

  it('keeps the first assignment when an id repeats', () => {
    const colors = assignVariantColors(lightTokens, [A, B, A]);
    expect(colors[A]).toBe(variantPalette(lightTokens)[0]);
  });
});
