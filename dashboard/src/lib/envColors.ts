// Environment identity colours. Deliberately disjoint from the state palette (ok = enabled,
// destructive = killed) so an environment chip can never be misread as a flag state.
// Unknown env keys — projects can create their own — fall back to neutral rather than
// hashing into an arbitrary hue, which would collide with the three known ones.

export type EnvColorKey = 'dev' | 'staging' | 'production' | 'neutral'

const KNOWN: Record<string, EnvColorKey> = {
  dev: 'dev',
  development: 'dev',
  staging: 'staging',
  stage: 'staging',
  production: 'production',
  prod: 'production',
}

export function envColorKey(envKey: string): EnvColorKey {
  return KNOWN[envKey.toLowerCase()] ?? 'neutral'
}

const CHIP_CLASSES: Record<EnvColorKey, string> = {
  dev: 'border-env-dev/40 bg-env-dev/10 text-env-dev-foreground',
  staging: 'border-env-staging/40 bg-env-staging/10 text-env-staging-foreground',
  production: 'border-env-production/40 bg-env-production/10 text-env-production-foreground',
  neutral: 'border-env-neutral/40 bg-env-neutral/10 text-env-neutral-foreground',
}

const DOT_CLASSES: Record<EnvColorKey, string> = {
  dev: 'bg-env-dev',
  staging: 'bg-env-staging',
  production: 'bg-env-production',
  neutral: 'bg-env-neutral',
}

/** Tailwind classes for a bordered chip in this environment's identity colour. */
export function envChipClasses(envKey: string): string {
  return CHIP_CLASSES[envColorKey(envKey)]
}

/** Tailwind classes for a small solid dot in this environment's identity colour. */
export function envDotClasses(envKey: string): string {
  return DOT_CLASSES[envColorKey(envKey)]
}

// Canonical left-to-right ordering: least to most dangerous. Anything unrecognised sorts
// after the known three, alphabetically, so custom environments have a stable position.
const ORDER: Record<EnvColorKey, number> = {
  dev: 0,
  staging: 1,
  production: 2,
  neutral: 3,
}

export function compareEnvKeys(a: string, b: string): number {
  const rank = ORDER[envColorKey(a)] - ORDER[envColorKey(b)]
  return rank !== 0 ? rank : a.localeCompare(b)
}

export function sortEnvKeys<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareEnvKeys(keyOf(a), keyOf(b)))
}
