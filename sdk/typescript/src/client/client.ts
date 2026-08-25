import type {
  BootstrapResponse,
  ClientBootstrapResponse,
  EvalContext,
  EvalReason,
  Flag,
  PatchEvent,
  ServerBulkEvalResponse,
  ServerEvalResult,
} from '../types.js';
import { evaluateFlag, isValidContextKey } from '../evaluation/index.js';
import { Telemetry, type TelemetryStats } from '../telemetry/telemetry.js';
import { Backoff, DEFAULT_BACKOFF } from './backoff.js';
import { resolveConfig, type ResolvedConfig, type SwitchboardConfig } from './config.js';
import { Emitter } from './emitter.js';
import {
  authHeaders,
  fetchBootstrap,
  fetchClientBootstrap,
  serverEvaluate,
  serverEvaluateAll,
  SwitchboardHttpError,
} from './http.js';
import type { Logger } from './logger.js';
import { SseClient, type SseMessage, unref } from './sse.js';
import { SwitchboardConfigError } from './config.js';
import { ClientStore, ConfigStore, type Snapshot } from './store.js';

/** Readiness of the in-memory config. */
export type ClientStatus = 'NOT_READY' | 'READY' | 'STALE' | 'ERROR';

/**
 * Why the SDK could not use the flag's own value. Absent on a normal evaluation, including one
 * that legitimately serves the off variation.
 */
export type EvaluationErrorKind =
  | 'FLAG_NOT_FOUND'
  | 'PARSE_ERROR'
  | 'INVALID_CONTEXT'
  | 'CLIENT_NOT_READY'
  | 'CONFIG_UNREADABLE';

export interface EvaluationDetail<T> {
  flagKey: string;
  value: T;
  variationId: string | null;
  /** The matched variation's display name, when the flag defines one. */
  variationName: string | null;
  /** Switchboard's own reason (spec/evaluation.md 1.3). */
  reason: EvalReason;
  /** Set if and only if `reason` is `RULE_MATCH`. */
  ruleId: string | null;
  errorKind?: EvaluationErrorKind;
  errorMessage?: string;
  /** The environment state version this answer came from; -1 before the first config arrives. */
  stateVersion: number;
  /** True when the config is older than `staleAfterMs`, or was never loaded at all. */
  stale: boolean;
}

export interface ClientEventMap {
  /** The first config has been loaded and local evaluation is live. */
  ready: { stateVersion: number };
  /** Config changed. `flagKeys` lists the changed flags, or every flag after a full replace. */
  change: { stateVersion: number; flagKeys: string[] };
  /** Transport failure. The client keeps serving its last-known config. */
  error: { error: unknown; willRetry: boolean };
  /** The config has gone quiet for longer than `staleAfterMs`. */
  stale: { lastContactAt: number };
}

const BOOLEAN_TRUE = 'true';
const BOOLEAN_FALSE = 'false';

/**
 * The Switchboard SDK client: in-memory config, local evaluation, streaming updates, telemetry.
 *
 * Usable on its own; {@link import('../provider.js').SwitchboardProvider} is a thin wrapper over it
 * for callers who want the OpenFeature API.
 *
 * The contract this class keeps above everything else: **it never throws into the host
 * application**. A flag check is on the critical path of everything that reads it, so a bootstrap
 * that fails, a stream that drops, a config that is malformed and a flag key that does not exist
 * all resolve to the caller's own default with a reason explaining why, and the problem is surfaced
 * through logs, events and `status` instead. The only throwing surface is the constructor, for a
 * configuration that could never work at all.
 */
export class SwitchboardClient {
  private readonly config: ResolvedConfig;
  private readonly store = new ConfigStore();
  private readonly telemetry: Telemetry;
  private readonly emitter = new Emitter<ClientEventMap>();
  private readonly logger: Logger;

  private sse: SseClient | null = null;
  /** Client mode only: evaluated values for {@link config.context}. Empty in server mode. */
  private readonly clientStore = new ClientStore();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private staleTimer: ReturnType<typeof setInterval> | null = null;
  private resyncing: Promise<void> | null = null;

  private etag: string | null = null;
  private lastContactAt = 0;
  private lastError: unknown = null;
  private started = false;
  private closed = false;
  private wasStale = false;
  private readyResolvers: Array<() => void> = [];

  constructor(config: SwitchboardConfig) {
    this.config = resolveConfig(config);
    this.logger = this.config.logger;
    this.telemetry = new Telemetry(this.config);
    if (this.config.initialBootstrap !== undefined) {
      // A caller-supplied snapshot (from a file, a cache, a previous process) means the very first
      // evaluation is a real answer rather than a default, even if the backend is down at boot.
      this.store.applyPut(this.config.initialBootstrap);
      this.lastContactAt = Date.now();
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------------------------

  /**
   * Loads the initial config and starts the update transport.
   *
   * Never rejects. If the bootstrap fails, the client starts anyway, keeps retrying in the
   * background (the SSE loop in streaming mode, the poll timer in polling mode) and serves
   * caller defaults with reason `SDK_DEFAULT` until config arrives.
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }
    this.started = true;
    this.closed = false;

    await this.loadBootstrap(true);

    if (this.config.mode === 'streaming') {
      this.startStream();
    } else {
      this.startPolling();
    }
    this.startStaleWatch();
    this.telemetry.start();
  }

  /**
   * Resolves once the first config has been loaded, or after `timeoutMs`, whichever comes first.
   *
   * Useful in streaming mode when the initial bootstrap failed but the stream may still deliver a
   * `put` shortly after. Never rejects.
   */
  waitForInitialization(timeoutMs = this.config.bootstrapTimeoutMs): Promise<boolean> {
    if (this.isInitialised) {
      return Promise.resolve(true);
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.readyResolvers = this.readyResolvers.filter((entry) => entry !== onReady);
        resolve(this.isInitialised);
      }, timeoutMs);
      unref(timer);
      const onReady = (): void => {
        clearTimeout(timer);
        resolve(true);
      };
      this.readyResolvers.push(onReady);
    });
  }

  /** Stops the transport, flushes telemetry and releases timers. Idempotent, never rejects. */
  async close(): Promise<void> {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.started = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.staleTimer !== null) {
      clearInterval(this.staleTimer);
      this.staleTimer = null;
    }
    try {
      await this.sse?.stop();
    } catch (error) {
      this.logger.warn('error stopping stream', error);
    }
    this.sse = null;
    await this.telemetry.close();
    this.emitter.removeAll();
    this.readyResolvers = [];
  }

  // ---------------------------------------------------------------------------------------------
  // Introspection
  // ---------------------------------------------------------------------------------------------

  get status(): ClientStatus {
    if (!this.isInitialised) {
      return this.lastError === null ? 'NOT_READY' : 'ERROR';
    }
    return this.isStale() ? 'STALE' : 'READY';
  }

  get stateVersion(): number {
    return this.config.keyKind === 'client'
      ? this.clientStore.stateVersion
      : this.store.stateVersion;
  }

  /**
   * Whichever store this key kind actually loads into.
   *
   * Client mode fills {@link clientStore} and leaves {@link store} empty forever, so reading
   * `store.isInitialised` reports NOT_READY on a client that is working perfectly - which is
   * exactly what it did before this existed.
   */
  private get isInitialised(): boolean {
    return this.config.keyKind === 'client'
      ? this.clientStore.isInitialised
      : this.store.isInitialised;
  }

  /** The current in-memory config. Useful for persisting a snapshot to seed the next process. */
  get snapshot(): Snapshot {
    return this.store.current;
  }

  get telemetryStats(): TelemetryStats {
    return this.telemetry.stats;
  }

  on<K extends keyof ClientEventMap>(
    event: K,
    listener: (payload: ClientEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  off<K extends keyof ClientEventMap>(
    event: K,
    listener: (payload: ClientEventMap[K]) => void,
  ): void {
    this.emitter.off(event, listener);
  }

  // ---------------------------------------------------------------------------------------------
  // Evaluation
  // ---------------------------------------------------------------------------------------------

  /**
   * Evaluates a flag and returns its raw string value.
   *
   * <p>In SERVER mode this is a local evaluation and `context` is required. In CLIENT mode the
   * server has already evaluated for the context given at construction, so `context` is ignored -
   * pass `undefined`, or use {@link setContext} to change who is being evaluated for.
   */
  stringValue(
flagKey: string,
context: EvalContext | undefined, defaultValue: string): string {
    return this.stringDetail(flagKey, context, defaultValue).value;
  }

  /** Evaluates a flag locally, returning the value plus why it was served. */
  stringDetail(
flagKey: string,
context: EvalContext | undefined,
    defaultValue: string,
  ): EvaluationDetail<string> {
    return this.evaluateLocal(flagKey, context, defaultValue);
  }

  booleanValue(
flagKey: string,
context: EvalContext | undefined, defaultValue: boolean): boolean {
    return this.booleanDetail(flagKey, context, defaultValue).value;
  }

  /**
   * Boolean flags are two-variation flags whose values are the strings `"true"` and `"false"`
   * (spec/evaluation.md 1.2). Anything else is a type mismatch and serves the caller's default.
   */
  booleanDetail(
flagKey: string,
context: EvalContext | undefined,
    defaultValue: boolean,
  ): EvaluationDetail<boolean> {
    const raw = this.evaluateLocal(flagKey, context, defaultValue ? BOOLEAN_TRUE : BOOLEAN_FALSE);
    if (raw.value === BOOLEAN_TRUE) {
      return { ...raw, value: true };
    }
    if (raw.value === BOOLEAN_FALSE) {
      return { ...raw, value: false };
    }
    return this.parseFailure(raw, defaultValue, `"${raw.value}" is not "true" or "false"`);
  }

  numberValue(
flagKey: string,
context: EvalContext | undefined, defaultValue: number): number {
    return this.numberDetail(flagKey, context, defaultValue).value;
  }

  /**
   * Switchboard flags are boolean or string on the wire, so a numeric flag is a string flag whose
   * variation values parse as numbers. An unparseable value serves the caller's default with
   * `errorKind: 'PARSE_ERROR'` rather than `NaN`.
   */
  numberDetail(
flagKey: string,
context: EvalContext | undefined,
    defaultValue: number,
  ): EvaluationDetail<number> {
    const raw = this.evaluateLocal(flagKey, context, String(defaultValue));
    const parsed = Number(raw.value);
    if (raw.value.trim() !== '' && Number.isFinite(parsed)) {
      return { ...raw, value: parsed };
    }
    return this.parseFailure(raw, defaultValue, `"${raw.value}" is not a finite number`);
  }

  jsonValue<T>(flagKey: string, context: EvalContext, defaultValue: T): T {
    return this.jsonDetail(flagKey, context, defaultValue).value;
  }

  /** Parses the variation value as JSON. Invalid JSON serves the caller's default. */
  jsonDetail<T>(flagKey: string, context: EvalContext, defaultValue: T): EvaluationDetail<T> {
    const raw = this.evaluateLocal(flagKey, context, '');
    if (raw.errorKind !== undefined || raw.value === '') {
      return { ...raw, value: defaultValue };
    }
    try {
      return { ...raw, value: JSON.parse(raw.value) as T };
    } catch (error) {
      return this.parseFailure(raw, defaultValue, `value is not valid JSON: ${String(error)}`);
    }
  }

  /**
   * Evaluates every flag the client knows about for one context.
   *
   * Intended for a dashboard, a debug endpoint or bootstrapping a frontend. Every entry is a
   * normal local evaluation, so this is still microseconds and still emits telemetry.
   */
  allFlags(context: EvalContext): Record<string, EvaluationDetail<string>> {
    const result: Record<string, EvaluationDetail<string>> = {};
    for (const flagKey of this.store.flagKeys) {
      result[flagKey] = this.evaluateLocal(flagKey, context, '');
    }
    return result;
  }

  /**
   * The heart of the client: look the flag up in memory and run the spec's precedence ladder.
   *
   * No I/O, no await, no network. Everything that can go wrong resolves to the caller's default.
   */
  private evaluateLocal(
    flagKey: string,
    context: EvalContext | undefined,
    defaultValue: string,
  ): EvaluationDetail<string> {
    if (this.config.keyKind === 'client') {
      return this.resolveFromClientStore(flagKey, defaultValue);
    }
    try {
      if (!isValidContextKey(context?.key)) {
        // Spec 1.1: an SDK must reject an empty or whitespace-only key rather than substitute one.
        // "Reject" here means "refuse to evaluate and report it", not "throw at the caller".
        return this.failure(
          flagKey,
          defaultValue,
          'INVALID_CONTEXT',
          'context.key is required and must not be blank',
        );
      }
      if (!this.store.isInitialised) {
        return this.failure(
          flagKey,
          defaultValue,
          'CLIENT_NOT_READY',
          'no config loaded yet; serving the caller default',
        );
      }
      const flag = this.store.getFlag(flagKey);
      if (flag === undefined) {
        // Spec 7: an unknown flag serves the caller's default and is never an error.
        return this.failure(
          flagKey,
          defaultValue,
          'FLAG_NOT_FOUND',
          `flag "${flagKey}" is not in this environment`,
        );
      }

      const snapshot = this.store.current;
      const outcome = evaluateFlag(flag, context as EvalContext, snapshot.segments, defaultValue);
      this.telemetry.recordEvaluation(
        flagKey, (context as EvalContext).key, outcome.variationId, outcome.reason);

      if (outcome.value === null) {
        // The config points at a variation the flag no longer defines (spec 1.3).
        return this.failure(
          flagKey,
          defaultValue,
          'CONFIG_UNREADABLE',
          `variation ${String(outcome.variationId)} is not defined on flag "${flagKey}"`,
        );
      }
      if (outcome.reason === 'SDK_DEFAULT') {
        // evaluateFlag only reports SDK_DEFAULT when it refused a malformed rollout (spec 6).
        return this.failure(
          flagKey,
          defaultValue,
          'CONFIG_UNREADABLE',
          `flag "${flagKey}" has a rollout whose weights are invalid`,
        );
      }

      return {
        flagKey,
        value: outcome.value,
        variationId: outcome.variationId,
        variationName: this.variationName(flag, outcome.variationId),
        reason: outcome.reason,
        ruleId: outcome.ruleId,
        stateVersion: snapshot.stateVersion,
        stale: this.isStale(),
      };
    } catch (error) {
      // Defence in depth. Nothing above should throw; if it somehow does, the host application
      // still gets its default rather than an exception on its request path.
      this.logger.error(`unexpected error evaluating "${flagKey}"`, error);
      return this.failure(flagKey, defaultValue, 'CONFIG_UNREADABLE', String(error));
    }
  }

  private variationName(flag: Flag, variationId: string | null): string | null {
    if (variationId === null) {
      return null;
    }
    return flag.variations.find((variation) => variation.id === variationId)?.name ?? null;
  }

  private failure(
    flagKey: string,
    defaultValue: string,
    errorKind: EvaluationErrorKind,
    errorMessage: string,
  ): EvaluationDetail<string> {
    return {
      flagKey,
      value: defaultValue,
      variationId: null,
      variationName: null,
      reason: 'SDK_DEFAULT',
      ruleId: null,
      errorKind,
      errorMessage,
      stateVersion: this.store.stateVersion,
      stale: this.isStale(),
    };
  }

  private parseFailure<T>(
    raw: EvaluationDetail<string>,
    defaultValue: T,
    message: string,
  ): EvaluationDetail<T> {
    return {
      ...raw,
      value: defaultValue,
      reason: 'SDK_DEFAULT',
      errorKind: raw.errorKind ?? 'PARSE_ERROR',
      errorMessage: raw.errorMessage ?? `flag "${raw.flagKey}": ${message}`,
    };
  }

  // ---------------------------------------------------------------------------------------------
  // Telemetry
  // ---------------------------------------------------------------------------------------------

  /**
   * Records a metric for the healing and optimizing loops: a conversion, an error, a latency.
   *
   * Buffered and flushed with the evaluation events. Use the same `contextKey` you evaluated with,
   * so Switchboard can attribute the outcome to the variation that context was served.
   */
  track(metricKey: string, contextKey: string, value = 1): void {
    if (!isValidContextKey(contextKey)) {
      this.logger.warn(`track("${metricKey}") ignored: contextKey is blank`);
      return;
    }
    this.telemetry.recordMetric(metricKey, contextKey, value);
  }

  /** Sends buffered telemetry now. Never rejects. */
  flush(): Promise<void> {
    return this.telemetry.flush();
  }

  // ---------------------------------------------------------------------------------------------
  // Server-side evaluation (fallback / verification path)
  // ---------------------------------------------------------------------------------------------

  /**
   * Asks the server to evaluate a flag, bypassing the local store.
   *
   * Not the primary path: it is a network round-trip, which is the cost local evaluation exists to
   * avoid. It is here as an escape hatch and as the way to prove client and server agree.
   */
  serverEvaluate(
    flagKey: string,
    context: EvalContext,
    defaultValue = '',
  ): Promise<ServerEvalResult> {
    return serverEvaluate(this.config, flagKey, context, defaultValue);
  }

  /** Asks the server to evaluate every flag in the environment. */
  serverEvaluateAll(context: EvalContext): Promise<ServerBulkEvalResponse> {
    return serverEvaluateAll(this.config, context);
  }

  /**
   * Client mode: read the answer the server already computed.
   *
   * There is no evaluation here and there cannot be - the payload carries values, not rules. A flag
   * absent from it is either genuinely unknown or not marked available to client-side SDKs, and
   * those two are deliberately indistinguishable; both serve the caller's default.
   */
  private resolveFromClientStore(flagKey: string, defaultValue: string): EvaluationDetail<string> {
    if (!this.clientStore.isInitialised) {
      return this.failure(
        flagKey,
        defaultValue,
        'CLIENT_NOT_READY',
        'no config loaded yet; serving the caller default',
      );
    }
    const flag = this.clientStore.getFlag(flagKey);
    if (flag === undefined) {
      return this.failure(
        flagKey,
        defaultValue,
        'FLAG_NOT_FOUND',
        `flag "${flagKey}" is not available to this client-side key`,
      );
    }
    const contextKey = this.config.context?.key ?? '';
    this.telemetry.recordEvaluation(flagKey, contextKey, flag.variationId ?? null, flag.reason);
    return {
      flagKey,
      value: flag.value,
      variationId: flag.variationId ?? null,
      variationName: flag.variationName ?? null,
      reason: flag.reason,
      ruleId: flag.ruleId ?? null,
      stateVersion: this.clientStore.stateVersion,
      stale: this.isStale(),
    };
  }

  /**
   * Client mode only: evaluate for a different context from now on.
   *
   * Re-fetches immediately and emits `change` for every flag, because in static-context mode any
   * flag's value may have moved. Awaiting it means the next evaluation sees the new context; not
   * awaiting it means evaluations keep returning the previous context's answers until it lands,
   * which is the safe behaviour either way.
   */
  async setContext(context: EvalContext): Promise<void> {
    if (this.config.keyKind !== 'client') {
      throw new SwitchboardConfigError(
        'setContext() is client-mode only. A server key takes a context per evaluation.',
      );
    }
    this.config.context = context;
    // The old ETag digests a payload for the OLD context, so keeping it would earn a 304 and
    // silently strand the client on the previous context's answers.
    this.etag = null;
    await this.loadBootstrap(false);
  }

  // ---------------------------------------------------------------------------------------------
  // Transport
  // ---------------------------------------------------------------------------------------------

  /** Fetches bootstrap. Returns true when config was loaded or confirmed current. */
  private async loadBootstrap(initial: boolean): Promise<boolean> {
    try {
      if (this.config.keyKind === 'client') {
        const context = this.config.context as EvalContext;
        const clientResult = await fetchClientBootstrap(this.config, this.etag, context);
        this.lastContactAt = Date.now();
        this.lastError = null;
        if (clientResult.status === 304) {
          this.logger.debug('client bootstrap unchanged (304)');
          return true;
        }
        this.etag = clientResult.etag;
        this.applyClientBootstrap(clientResult.payload, context);
        return true;
      }
      const result = await fetchBootstrap(this.config, this.etag);
      this.lastContactAt = Date.now();
      this.lastError = null;
      if (result.status === 304) {
        this.logger.debug('bootstrap unchanged (304)');
        return true;
      }
      this.etag = result.etag;
      this.applyBootstrap(result.payload);
      return true;
    } catch (error) {
      this.lastError = error;
      const unauthorized = error instanceof SwitchboardHttpError && error.isUnauthorized;
      const message = initial
        ? 'initial bootstrap failed; serving caller defaults and retrying in the background'
        : 'bootstrap refresh failed; serving the last known config';
      if (unauthorized) {
        this.logger.error(`${message} (the SDK key was rejected)`, error);
      } else {
        this.logger.warn(message, error);
      }
      this.emit('error', { error, willRetry: !unauthorized });
      return false;
    }
  }

  private applyClientBootstrap(payload: ClientBootstrapResponse, requested: EvalContext): void {
    const wasInitialised = this.clientStore.isInitialised;
    const changed = this.clientStore.apply(payload);

    if (payload.flags.length === 0) {
      // The single most likely first-run confusion, and it is not a failure: client_side_available
      // is off by default, so a brand-new client key sees nothing until a flag is published to it.
      this.logger.warn(
        'client bootstrap returned no flags. Flags are hidden from client-side keys until they ' +
          'are marked "available to client-side SDKs" on the flag\'s settings tab.',
      );
    }

    if (!wasInitialised) {
      this.emit('ready', { stateVersion: payload.stateVersion });
      const resolvers = this.readyResolvers;
      this.readyResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
    if (changed) {
      this.emit('change', {
        stateVersion: payload.stateVersion,
        flagKeys: this.clientStore.flagKeys,
      });
    }
    void requested;
  }

  private applyBootstrap(payload: BootstrapResponse): void {
    const wasInitialised = this.store.isInitialised;
    const changed = this.store.applyPut(payload);
    if (!wasInitialised) {
      this.emit('ready', { stateVersion: payload.stateVersion });
      const resolvers = this.readyResolvers;
      this.readyResolvers = [];
      for (const resolve of resolvers) {
        resolve();
      }
    }
    if (changed) {
      this.emit('change', { stateVersion: payload.stateVersion, flagKeys: this.store.flagKeys });
    }
  }

  private startStream(): void {
    const backoff = new Backoff({ ...DEFAULT_BACKOFF });
    this.sse = new SseClient({
      url: `${this.config.baseUrl}/api/stream`,
      headers: authHeaders(this.config),
      fetch: this.config.fetch,
      backoff,
      logger: this.logger,
      // The stream's event id is the environment state version, so a reconnect resumes from the
      // version we last applied.
      lastEventId: this.store.isInitialised ? String(this.store.stateVersion) : null,
      onOpen: () => {
        this.lastContactAt = Date.now();
        this.lastError = null;
        this.logger.debug('stream connected');
      },
      onMessage: (message) => this.onStreamMessage(message),
      onError: (error, retryInMs) => {
        this.lastError = error;
        this.emit('error', { error, willRetry: retryInMs !== null });
      },
    });
    this.sse.start();
  }

  private onStreamMessage(message: SseMessage): void {
    this.lastContactAt = Date.now();
    try {
      switch (message.type) {
        case 'put': {
          this.applyBootstrap(JSON.parse(message.data) as BootstrapResponse);
          this.lastError = null;
          break;
        }
        case 'patch': {
          const patch = JSON.parse(message.data) as PatchEvent;
          const applied = this.store.applyPatch(patch);
          if (applied) {
            this.emit('change', {
              stateVersion: patch.stateVersion,
              flagKeys: [patch.flagKey],
            });
          } else {
            // A patch carries no variations or kind, so a flag we have never seen cannot be built
            // from it. Resynchronise from bootstrap instead of guessing.
            this.logger.debug(`patch for unknown flag "${patch.flagKey}"; resyncing`);
            void this.resync();
          }
          break;
        }
        case 'refetch': {
          // Client mode's only change signal. It deliberately names no flag - that would leak
          // which flag moved, including flags this key may not see at all - so the response is
          // always a full refetch.
          this.lastError = null;
          void this.resync();
          break;
        }
        case 'ping':
          // Liveness only: lastContactAt above is the whole point of the event.
          break;
        default:
          this.logger.debug(`ignoring unknown stream event "${message.type}"`);
          break;
      }
    } catch (error) {
      this.logger.warn(`failed to apply stream event "${message.type}"`, error);
      this.emit('error', { error, willRetry: true });
    }
  }

  /** Refetches the full config, coalescing concurrent requests. */
  private resync(): Promise<void> {
    if (this.resyncing !== null) {
      return this.resyncing;
    }
    this.etag = null;
    this.resyncing = this.loadBootstrap(false).then(
      () => {
        this.resyncing = null;
      },
      () => {
        this.resyncing = null;
      },
    );
    return this.resyncing;
  }

  private startPolling(): void {
    this.pollTimer = setInterval(() => {
      void this.loadBootstrap(false);
    }, this.config.pollIntervalMs);
    unref(this.pollTimer);
  }

  private isStale(): boolean {
    if (!this.isInitialised) {
      return true;
    }
    if (this.config.staleAfterMs === 0) {
      return false;
    }
    return Date.now() - this.lastContactAt > this.config.staleAfterMs;
  }

  private startStaleWatch(): void {
    if (this.config.staleAfterMs === 0) {
      return;
    }
    const interval = Math.max(1_000, Math.floor(this.config.staleAfterMs / 2));
    this.staleTimer = setInterval(() => {
      const stale = this.isStale();
      if (stale && !this.wasStale && this.isInitialised) {
        this.wasStale = true;
        this.logger.warn(
          `config has not been refreshed for ${Date.now() - this.lastContactAt}ms; serving the last known state`,
        );
        this.emit('stale', { lastContactAt: this.lastContactAt });
      } else if (!stale && this.wasStale) {
        this.wasStale = false;
        this.emit('ready', { stateVersion: this.store.stateVersion });
      }
    }, interval);
    unref(this.staleTimer);
  }

  private emit<K extends keyof ClientEventMap>(event: K, payload: ClientEventMap[K]): void {
    this.emitter.emit(event, payload, (error) =>
      this.logger.warn(`a "${String(event)}" listener threw`, error),
    );
  }
}
