import type { ThemeTokens } from '@shared/theme';

/**
 * Categorical colors for variant bars and sparklines.
 *
 * Every entry is a SEMANTIC TOKEN, so the ramp re-derives itself per theme and
 * stays readable in light and dark — the env-tint inks are already contrast-
 * tuned per mode, and the accent appears exactly once instead of painting every
 * variant the same orange.
 */
export function variantPalette(tokens: ThemeTokens): readonly string[] {
  return [
    tokens.tints.dev.ink,
    tokens.accent.primaryDark,
    tokens.tints.production.ink,
    tokens.tints.staging.ink,
    tokens.text.secondary,
  ];
}

export const VARIANT_PALETTE_SIZE = 5;

/**
 * FNV-1a over the id. Only used when no ordering is known (a lone variation id
 * from an anomaly finding); two ids CAN land on the same slot, which is why
 * ordered assignment below is preferred wherever a variant set is available.
 */
export function hashSlot(variationId: string, size: number = VARIANT_PALETTE_SIZE): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < variationId.length; i += 1) {
    hash ^= variationId.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % size;
}

/**
 * Palette slot for a variation. When `order` contains the id, the slot is its
 * position (collision-free up to palette length and stable as long as the
 * server returns variants in a stable order); otherwise it falls back to the
 * hash so an unknown id still gets a consistent color.
 */
export function variantSlot(
  variationId: string,
  order?: readonly string[],
  size: number = VARIANT_PALETTE_SIZE,
): number {
  const index = order?.indexOf(variationId) ?? -1;
  if (index >= 0) return index % size;
  return hashSlot(variationId, size);
}

export function variantColor(
  tokens: ThemeTokens,
  variationId: string,
  order?: readonly string[],
): string {
  const palette = variantPalette(tokens);
  return palette[variantSlot(variationId, order, palette.length)];
}

/** Whole-set assignment; the map is what bar/sparkline renderers read from. */
export function assignVariantColors(
  tokens: ThemeTokens,
  variationIds: readonly string[],
): Record<string, string> {
  const palette = variantPalette(tokens);
  const out: Record<string, string> = {};
  variationIds.forEach((id, i) => {
    if (out[id] === undefined) out[id] = palette[i % palette.length];
  });
  return out;
}
