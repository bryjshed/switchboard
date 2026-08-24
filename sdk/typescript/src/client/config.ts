import type { BootstrapResponse } from '../types.js';
import type { Logger } from './logger.js';
import { defaultLogger, safeLogger } from './logger.js';

/** How the SDK keeps its in-memory config fresh. */
export type UpdateMode = 'streaming' | 'polling';

/** Telemetry settings. Telemetry is what feeds Switchboard's healing and optimizing loops. */
export interface TelemetryOptions {
  /** Send evaluation events. Default true. */
  enabled?: boolean;
  /** Flush interval in milliseconds. Default 10000. */
  flushIntervalMs?: number;
  /** Maximum events held in memory per queue. Oldest are dropped past this. Default 10000. */
  maxQueueSize?: number;
  /** Maximum events per HTTP request. The API caps a batch at 500. Default 500. */
  maxBatchSize?: number;
}

/** Anything with the shape of `globalThis.fetch`. Injectable for tests and for proxy agents. */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface SwitchboardConfig {
  /** Server-side SDK key, `sb_srv_...`. Required. */
  sdkKey: string;
  /** Switchboard API origin. Default `http://localhost:28080`. */
  baseUrl?: string;
  /** `streaming` (SSE, default) or `polling` (conditional GET on bootstrap). */
  mode?: UpdateMode;
  /** Poll interval for `polling` mode, in milliseconds. Default 30000. */
  pollIntervalMs?: number;
  /** How long `start()` waits for the first bootstrap before returning, in ms. Default 5000. */
  bootstrapTimeoutMs?: number;
  /** Marks the config stale after this long without any stream traffic. Default 60000, 0 disables. */
  staleAfterMs?: number;
  telemetry?: TelemetryOptions | boolean;
  logger?: Logger;
  /** Injectable fetch. Defaults to the global. */
  fetch?: FetchLike;
  /** Seed the store from a previous snapshot so the very first evaluation is never a default. */
  initialBootstrap?: BootstrapResponse;
}

export type ResolvedTelemetryOptions = Required<TelemetryOptions>;

export interface ResolvedConfig {
  sdkKey: string;
  baseUrl: string;
  mode: UpdateMode;
  pollIntervalMs: number;
  bootstrapTimeoutMs: number;
  staleAfterMs: number;
  telemetry: ResolvedTelemetryOptions;
  logger: Logger;
  fetch: FetchLike;
  initialBootstrap?: BootstrapResponse;
}

export const DEFAULTS = {
  baseUrl: 'http://localhost:28080',
  mode: 'streaming' as UpdateMode,
  pollIntervalMs: 30_000,
  bootstrapTimeoutMs: 5_000,
  staleAfterMs: 60_000,
  telemetry: {
    enabled: true,
    flushIntervalMs: 10_000,
    maxQueueSize: 10_000,
    maxBatchSize: 500,
  } satisfies ResolvedTelemetryOptions,
} as const;

/** Thrown by the constructor only, for a config that can never work. Never thrown at evaluation. */
export class SwitchboardConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SwitchboardConfigError';
  }
}

function positive(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new SwitchboardConfigError(`${name} must be a non-negative finite number, got ${value}`);
  }
  return value;
}

export function resolveConfig(config: SwitchboardConfig): ResolvedConfig {
  if (typeof config.sdkKey !== 'string' || config.sdkKey.trim().length === 0) {
    throw new SwitchboardConfigError('sdkKey is required');
  }
  const mode = config.mode ?? DEFAULTS.mode;
  if (mode !== 'streaming' && mode !== 'polling') {
    throw new SwitchboardConfigError(`mode must be "streaming" or "polling", got ${String(mode)}`);
  }

  const telemetryInput: TelemetryOptions =
    config.telemetry === undefined
      ? {}
      : typeof config.telemetry === 'boolean'
        ? { enabled: config.telemetry }
        : config.telemetry;

  const fetchImpl = config.fetch ?? (globalThis.fetch as FetchLike | undefined);
  if (typeof fetchImpl !== 'function') {
    throw new SwitchboardConfigError(
      'no fetch implementation available; pass config.fetch or run on Node 18+',
    );
  }

  return {
    sdkKey: config.sdkKey.trim(),
    baseUrl: (config.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, ''),
    mode,
    pollIntervalMs: positive(config.pollIntervalMs, DEFAULTS.pollIntervalMs, 'pollIntervalMs'),
    bootstrapTimeoutMs: positive(
      config.bootstrapTimeoutMs,
      DEFAULTS.bootstrapTimeoutMs,
      'bootstrapTimeoutMs',
    ),
    staleAfterMs: positive(config.staleAfterMs, DEFAULTS.staleAfterMs, 'staleAfterMs'),
    telemetry: {
      enabled: telemetryInput.enabled ?? DEFAULTS.telemetry.enabled,
      flushIntervalMs: positive(
        telemetryInput.flushIntervalMs,
        DEFAULTS.telemetry.flushIntervalMs,
        'telemetry.flushIntervalMs',
      ),
      maxQueueSize: Math.max(
        1,
        positive(telemetryInput.maxQueueSize, DEFAULTS.telemetry.maxQueueSize, 'telemetry.maxQueueSize'),
      ),
      maxBatchSize: Math.min(
        500,
        Math.max(
          1,
          positive(
            telemetryInput.maxBatchSize,
            DEFAULTS.telemetry.maxBatchSize,
            'telemetry.maxBatchSize',
          ),
        ),
      ),
    },
    logger: safeLogger(config.logger ?? defaultLogger()),
    fetch: fetchImpl,
    initialBootstrap: config.initialBootstrap,
  };
}
