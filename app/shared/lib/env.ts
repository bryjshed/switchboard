import type { EnvironmentResponse } from '../api/types';
import type { BadgeTone } from '../ui/Badge';

/** Canonical promotion order; anything else sorts after, alphabetically. */
const ENV_ORDER = ['dev', 'staging', 'production'] as const;

export const DEFAULT_ENV_KEY = 'production';

function rank(key: string): number {
  const i = ENV_ORDER.indexOf(key as (typeof ENV_ORDER)[number]);
  return i === -1 ? ENV_ORDER.length : i;
}

/** dev → staging → production → extras (alphabetical). Pure; never mutates. */
export function orderEnvKeys<T extends { envKey: string }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => {
    const d = rank(a.envKey) - rank(b.envKey);
    return d !== 0 ? d : a.envKey.localeCompare(b.envKey);
  });
}

/** Same ordering for EnvironmentResponse (keyed by `key`, not `envKey`). */
export function orderEnvironments(envs: readonly EnvironmentResponse[]): EnvironmentResponse[] {
  return [...envs].sort((a, b) => {
    const d = rank(a.key) - rank(b.key);
    return d !== 0 ? d : a.key.localeCompare(b.key);
  });
}

/** Short label for segmented controls / chips. */
export function envLabel(key: string): string {
  if (key === 'production') return 'Prod';
  if (key === 'dev') return 'Dev';
  return key.charAt(0).toUpperCase() + key.slice(1);
}

/** Env identity tint; unknown envs fall back to neutral rather than inventing one. */
export function envTone(key: string): BadgeTone {
  if (key === 'dev' || key === 'staging' || key === 'production') return key;
  return 'neutral';
}

/**
 * Picks the env to show when the persisted one is gone (project switch,
 * env deleted): production if present, else the first in promotion order.
 */
export function resolveEnvKey(
  envKeys: readonly string[],
  preferred: string | null | undefined,
): string | undefined {
  if (preferred && envKeys.includes(preferred)) return preferred;
  if (envKeys.includes(DEFAULT_ENV_KEY)) return DEFAULT_ENV_KEY;
  return orderEnvKeys(envKeys.map((envKey) => ({ envKey })))[0]?.envKey;
}

/** Environment id for an env key — anomaly and stats endpoints are id-addressed. */
export function findEnvId(
  environments: readonly EnvironmentResponse[],
  envKey: string | undefined,
): string | undefined {
  if (!envKey) return undefined;
  return environments.find((e) => e.key === envKey)?.id;
}
