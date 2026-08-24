import {
  ErrorCode,
  OpenFeatureEventEmitter,
  ProviderEvents,
  ProviderStatus,
  StandardResolutionReasons,
} from '@openfeature/server-sdk';
import type {
  EvaluationContext,
  EvaluationContextValue,
  FlagMetadata,
  JsonValue,
  Provider,
  ProviderMetadata,
  ResolutionDetails,
  ResolutionReason,
  TrackingEventDetails,
} from '@openfeature/server-sdk';
import { SwitchboardClient, type EvaluationDetail, type EvaluationErrorKind } from './client/client.js';
import type { SwitchboardConfig } from './client/config.js';
import type { EvalContext, EvalReason } from './types.js';

/**
 * Maps Switchboard's reasons onto OpenFeature's (spec/evaluation.md 1.3).
 *
 * Two of ours have no clean counterpart, so the mapping is lossy in one direction only:
 * `KILL_SWITCH` and `FLAG_OFF` both become `DISABLED`, and `TARGET_MATCH` and `RULE_MATCH` both
 * become `TARGETING_MATCH`. The distinctions the dashboard and audit log depend on are preserved
 * verbatim in `flagMetadata.switchboardReason`, so nothing is actually lost.
 */
const REASON_MAP: Record<EvalReason, ResolutionReason> = {
  KILL_SWITCH: StandardResolutionReasons.DISABLED,
  FLAG_OFF: StandardResolutionReasons.DISABLED,
  TARGET_MATCH: StandardResolutionReasons.TARGETING_MATCH,
  RULE_MATCH: StandardResolutionReasons.TARGETING_MATCH,
  ROLLOUT: StandardResolutionReasons.SPLIT,
  DEFAULT: StandardResolutionReasons.DEFAULT,
  SDK_DEFAULT: StandardResolutionReasons.DEFAULT,
};

const ERROR_CODE_MAP: Record<EvaluationErrorKind, ErrorCode> = {
  FLAG_NOT_FOUND: ErrorCode.FLAG_NOT_FOUND,
  PARSE_ERROR: ErrorCode.PARSE_ERROR,
  INVALID_CONTEXT: ErrorCode.TARGETING_KEY_MISSING,
  CLIENT_NOT_READY: ErrorCode.PROVIDER_NOT_READY,
  CONFIG_UNREADABLE: ErrorCode.PARSE_ERROR,
};

export interface SwitchboardProviderOptions extends SwitchboardConfig {
  /** Name reported as the provider's metadata name. Default `switchboard`. */
  name?: string;
}

/**
 * OpenFeature provider backed by {@link SwitchboardClient}.
 *
 * A thin wrapper: all the behaviour lives in the client, so callers who do not want the
 * OpenFeature dependency get exactly the same evaluation semantics from
 * `@switchboard/openfeature-provider/core`.
 *
 * ```ts
 * const provider = new SwitchboardProvider({ sdkKey: process.env.SWITCHBOARD_SDK_KEY! });
 * await OpenFeature.setProviderAndWait(provider);
 * const client = OpenFeature.getClient();
 * const on = await client.getBooleanValue('new-checkout', false, { targetingKey: 'user-3' });
 * ```
 */
export class SwitchboardProvider implements Provider {
  readonly runsOn = 'server' as const;
  readonly metadata: ProviderMetadata;
  readonly events = new OpenFeatureEventEmitter();

  private readonly client: SwitchboardClient;
  private readonly unsubscribes: Array<() => void> = [];

  constructor(options: SwitchboardProviderOptions | SwitchboardClient) {
    if (options instanceof SwitchboardClient) {
      this.client = options;
      this.metadata = { name: 'switchboard' };
    } else {
      const { name, ...config } = options;
      this.client = new SwitchboardClient(config);
      this.metadata = { name: name ?? 'switchboard' };
    }
    this.wireEvents();
  }

  /** The underlying client, for `track()`, `allFlags()`, snapshots and status. */
  get switchboard(): SwitchboardClient {
    return this.client;
  }

  /**
   * Readiness, for the OpenFeature SDK versions that still read it.
   *
   * `STALE` means the config is older than `staleAfterMs` and the SDK is deliberately still
   * serving it, which is the correct behaviour when the backend is unreachable.
   */
  get status(): ProviderStatus {
    switch (this.client.status) {
      case 'READY':
        return ProviderStatus.READY;
      case 'STALE':
        return ProviderStatus.STALE;
      case 'ERROR':
        return ProviderStatus.ERROR;
      default:
        return ProviderStatus.NOT_READY;
    }
  }

  /**
   * Loads config and starts streaming.
   *
   * Resolves even when the bootstrap fails, and emits `PROVIDER_ERROR` instead of rejecting. A
   * feature-flag provider that refuses to initialize takes the host application's startup with it;
   * serving defaults while retrying in the background is the safer failure mode, and the caller can
   * see the real state through `status` and the provider's events.
   */
  async initialize(): Promise<void> {
    await this.client.start();
    if (this.client.status !== 'READY') {
      // Give a streaming client the chance to be filled in by the stream's initial `put`.
      await this.client.waitForInitialization();
    }
    if ((this.client.status as string) !== 'READY') {
      this.events.emit(ProviderEvents.Error, {
        message: 'Switchboard bootstrap failed; serving defaults and retrying in the background',
      });
    }
  }

  async onClose(): Promise<void> {
    for (const unsubscribe of this.unsubscribes) {
      unsubscribe();
    }
    this.unsubscribes.length = 0;
    await this.client.close();
  }

  resolveBooleanEvaluation(
    flagKey: string,
    defaultValue: boolean,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<boolean>> {
    return Promise.resolve(
      toResolution(this.client.booleanDetail(flagKey, toEvalContext(context), defaultValue)),
    );
  }

  resolveStringEvaluation(
    flagKey: string,
    defaultValue: string,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<string>> {
    return Promise.resolve(
      toResolution(this.client.stringDetail(flagKey, toEvalContext(context), defaultValue)),
    );
  }

  resolveNumberEvaluation(
    flagKey: string,
    defaultValue: number,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<number>> {
    return Promise.resolve(
      toResolution(this.client.numberDetail(flagKey, toEvalContext(context), defaultValue)),
    );
  }

  resolveObjectEvaluation<T extends JsonValue>(
    flagKey: string,
    defaultValue: T,
    context: EvaluationContext,
  ): Promise<ResolutionDetails<T>> {
    return Promise.resolve(
      toResolution(this.client.jsonDetail<T>(flagKey, toEvalContext(context), defaultValue)),
    );
  }

  /** OpenFeature tracking, routed to `POST /api/events/metrics` for the healing loop. */
  track(
    trackingEventName: string,
    context: EvaluationContext,
    trackingEventDetails?: TrackingEventDetails,
  ): void {
    const key = contextKeyOf(context);
    if (key === undefined) {
      return;
    }
    this.client.track(trackingEventName, key, trackingEventDetails?.value ?? 1);
  }

  private wireEvents(): void {
    this.unsubscribes.push(
      this.client.on('ready', ({ stateVersion }) => {
        this.events.emit(ProviderEvents.Ready, { message: `state version ${stateVersion}` });
      }),
      this.client.on('change', ({ flagKeys }) => {
        this.events.emit(ProviderEvents.ConfigurationChanged, { flagsChanged: flagKeys });
      }),
      this.client.on('stale', () => {
        this.events.emit(ProviderEvents.Stale, {
          message: 'Switchboard config is stale; serving the last known state',
        });
      }),
      this.client.on('error', ({ error }) => {
        this.events.emit(ProviderEvents.Error, { message: String(error) });
      }),
    );
  }
}

/**
 * Maps an OpenFeature `EvaluationContext` onto Switchboard's `{key, attributes}`.
 *
 * `targetingKey` becomes `context.key` (a bare `key` field is accepted as a fallback). Every other
 * field becomes a STRING attribute, because every comparison in spec/evaluation.md is a
 * case-sensitive string comparison with no coercion - so the coercion has to happen here, once,
 * visibly, rather than inside the comparison:
 *
 * | context value      | attribute value                    |
 * |--------------------|------------------------------------|
 * | `string`           | unchanged                          |
 * | `number`           | `String(value)`, e.g. `42`, `1.5`  |
 * | `boolean`          | `"true"` / `"false"`               |
 * | `Date`             | ISO 8601, e.g. `2026-08-22T…Z`     |
 * | object or array    | `JSON.stringify(value)`            |
 * | `null`/`undefined` | omitted entirely                   |
 *
 * Omitting nulls rather than writing `"null"` is deliberate: spec/evaluation.md 3.1 says a MISSING
 * attribute fails its clause, which is what an absent value should do. Writing the string `"null"`
 * would let `EQUALS "null"` match, which no one means.
 */
export function toEvalContext(context: EvaluationContext | undefined): EvalContext {
  const attributes: Record<string, string> = {};
  for (const [name, value] of Object.entries(context ?? {})) {
    if (name === 'targetingKey' || name === 'key') {
      continue;
    }
    const coerced = coerceAttribute(value);
    if (coerced !== undefined) {
      attributes[name] = coerced;
    }
  }
  return { key: contextKeyOf(context) ?? '', attributes };
}

function contextKeyOf(context: EvaluationContext | undefined): string | undefined {
  if (context === undefined) {
    return undefined;
  }
  if (typeof context.targetingKey === 'string' && context.targetingKey.trim() !== '') {
    return context.targetingKey;
  }
  const bare = (context as Record<string, unknown>)['key'];
  return typeof bare === 'string' && bare.trim() !== '' ? bare : undefined;
}

function coerceAttribute(value: EvaluationContextValue): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

/** Turns a Switchboard evaluation detail into an OpenFeature `ResolutionDetails`. */
function toResolution<T>(detail: EvaluationDetail<T>): ResolutionDetails<T> {
  const flagMetadata: FlagMetadata = {
    switchboardReason: detail.reason,
    stateVersion: detail.stateVersion,
    stale: detail.stale,
  };
  if (detail.variationId !== null) {
    flagMetadata['variationId'] = detail.variationId;
  }
  if (detail.ruleId !== null) {
    flagMetadata['ruleId'] = detail.ruleId;
  }

  const resolution: ResolutionDetails<T> = {
    value: detail.value,
    reason: resolutionReason(detail),
    flagMetadata,
  };
  // The variant identifies which variation was served. Names are what the dashboard shows, so they
  // are preferred; the stable id is always in flagMetadata.
  const variant = detail.variationName ?? detail.variationId;
  if (variant !== null) {
    resolution.variant = variant;
  }
  if (detail.errorKind !== undefined) {
    resolution.errorCode = ERROR_CODE_MAP[detail.errorKind];
    resolution.errorMessage = detail.errorMessage;
  }
  return resolution;
}

function resolutionReason<T>(detail: EvaluationDetail<T>): ResolutionReason {
  if (detail.errorKind !== undefined) {
    return StandardResolutionReasons.ERROR;
  }
  if (detail.stale) {
    // The answer is real and locally computed, but from config that may be behind the server.
    return StandardResolutionReasons.STALE;
  }
  return REASON_MAP[detail.reason];
}
