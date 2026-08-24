import type {
  FlagTargetingConfig,
  RolloutOrVariation,
  Variation,
  WeightedVariation,
} from '@shared/api/types';

/** Detents the ramp slider snaps to. */
export const RAMP_DETENTS = [0, 5, 10, 25, 50, 75, 100] as const;

/**
 * A rollout is present only when it has entries: the backend serializes an
 * empty `rollout: []` alongside a fixed `variationId`, so truthiness alone
 * would misread every fixed fallthrough as a rollout.
 */
export function isRollout(serve: RolloutOrVariation | undefined): boolean {
  return !!serve?.rollout && serve.rollout.length > 0;
}

/** Sum of rollout weights. Pure — the sum-to-100 rule is enforced by callers. */
export function rolloutSum(rollout: readonly WeightedVariation[] | undefined): number {
  return (rollout ?? []).reduce((total, w) => total + (Number.isFinite(w.weight) ? w.weight : 0), 0);
}

/** A rollout is writable only when every weight is a non-negative integer and they total 100. */
export function isValidRollout(rollout: readonly WeightedVariation[] | undefined): boolean {
  if (!rollout || rollout.length < 2) return false;
  if (rollout.some((w) => !Number.isInteger(w.weight) || w.weight < 0 || w.weight > 100)) {
    return false;
  }
  return rolloutSum(rollout) === 100;
}

/** Every serve slot must resolve: a fixed variation or a valid rollout, never both. */
export function isValidServe(serve: RolloutOrVariation | undefined): boolean {
  if (!serve) return false;
  if (isRollout(serve)) return isValidRollout(serve.rollout);
  return !!serve.variationId;
}

/**
 * Ramp percentage = weight of the DEFAULT variation in the fallthrough rollout,
 * matching the backend's FlagEnvSummary.rolloutPercentage. Null when the
 * fallthrough serves a fixed variation.
 */
export function rampPercentage(config: FlagTargetingConfig): number | null {
  if (!isRollout(config.fallthrough)) return null;
  const match = config.fallthrough.rollout?.find(
    (w) => w.variationId === config.defaultVariationId,
  );
  return match ? match.weight : null;
}

/** True when the fallthrough is a two-way rollout — the shape the ramp slider can drive. */
export function isTwoWayRamp(config: FlagTargetingConfig): boolean {
  return isRollout(config.fallthrough) && (config.fallthrough.rollout?.length ?? 0) === 2;
}

/**
 * Rewrites the fallthrough as a two-way rollout at `percent` on the default
 * variation; the remainder goes to the other side of the existing rollout (or
 * the off variation when converting from a fixed fallthrough).
 */
export function withRampPercent(config: FlagTargetingConfig, percent: number): FlagTargetingConfig {
  const pct = clampPercent(percent);
  const current = config.fallthrough.rollout ?? [];
  const other =
    current.find((w) => w.variationId !== config.defaultVariationId)?.variationId ??
    config.offVariationId;
  return {
    ...config,
    fallthrough: {
      rollout: [
        { variationId: config.defaultVariationId, weight: pct },
        { variationId: other, weight: 100 - pct },
      ],
    },
  };
}

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) return 0;
  return Math.max(0, Math.min(100, Math.round(percent)));
}

/** Nearest detent to an arbitrary percentage (slider drag → snap). */
export function snapToDetent(percent: number): number {
  const pct = clampPercent(percent);
  return RAMP_DETENTS.reduce((best, d) =>
    Math.abs(d - pct) < Math.abs(best - pct) ? d : best,
  );
}

export function variationLabel(
  variations: readonly Variation[],
  variationId: string | undefined,
): string {
  if (!variationId) return 'none';
  const match = variations.find((v) => v.id === variationId);
  if (!match) return 'unknown variation';
  return match.name?.trim() || match.value;
}

/** One-line human summary of a serve slot ("Serves True", "50% True / 50% False"). */
export function describeServe(
  serve: RolloutOrVariation | undefined,
  variations: readonly Variation[],
): string {
  if (!serve) return 'Not configured';
  if (isRollout(serve)) {
    return (serve.rollout ?? [])
      .map((w) => `${w.weight}% ${variationLabel(variations, w.variationId)}`)
      .join(' / ');
  }
  return `Serves ${variationLabel(variations, serve.variationId)}`;
}

/** Counts for the detail screen's targeting summary line. */
export function targetingCounts(config: FlagTargetingConfig): {
  ruleCount: number;
  targetCount: number;
} {
  return {
    ruleCount: config.rules?.length ?? 0,
    targetCount: config.individualTargets?.length ?? 0,
  };
}

/**
 * Slugs a display name into a flag key matching the backend pattern
 * ^[a-z][a-z0-9-]*$ (max 128). Returns '' when nothing usable remains, so the
 * form can keep the Create button disabled.
 */
export function slugifyKey(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 128);
  // The key must start with a letter; drop any leading digits.
  const trimmed = slug.replace(/^[0-9-]+/, '');
  return trimmed.replace(/-+$/, '');
}

export const FLAG_KEY_PATTERN = /^[a-z][a-z0-9-]*$/;

export function isValidFlagKey(key: string): boolean {
  return key.length > 0 && key.length <= 128 && FLAG_KEY_PATTERN.test(key);
}

/** Boolean flags always serve the variation whose value is "true" as the "on" side. */
export function booleanOnVariationId(variations: readonly Variation[]): string | undefined {
  return variations.find((v) => v.value === 'true')?.id;
}
