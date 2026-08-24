import type { Variation } from '@/types/api'

/** Human label for a variation: its name when it has one, otherwise the raw value. */
export function variationLabel(variation: Variation | undefined, fallback = 'Unknown variation'): string {
  if (!variation) return fallback
  return variation.name?.trim() || variation.value
}

export function findVariation(variations: readonly Variation[], id: string | undefined) {
  return id ? variations.find((v) => v.id === id) : undefined
}
