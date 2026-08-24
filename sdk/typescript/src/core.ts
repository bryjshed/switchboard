/**
 * Core entry point: everything except the OpenFeature provider.
 *
 * Import from `@switchboard/openfeature-provider/core` when you do not want
 * `@openfeature/server-sdk` in your dependency tree. This module has zero runtime dependencies.
 */
export { SwitchboardClient } from './client/client.js';
export type {
  ClientEventMap,
  ClientStatus,
  EvaluationDetail,
  EvaluationErrorKind,
} from './client/client.js';
export {
  DEFAULTS,
  SwitchboardConfigError,
  resolveConfig,
  type FetchLike,
  type ResolvedConfig,
  type SwitchboardConfig,
  type TelemetryOptions,
  type UpdateMode,
} from './client/config.js';
export { SwitchboardHttpError } from './client/http.js';
export { defaultLogger, safeLogger, silentLogger, type Logger } from './client/logger.js';
export { ConfigStore, type Snapshot } from './client/store.js';
export { Backoff, DEFAULT_BACKOFF, type BackoffOptions } from './client/backoff.js';
export { SseClient, SseParser, type SseMessage } from './client/sse.js';
export { Telemetry, type TelemetryStats } from './telemetry/telemetry.js';

// The evaluator itself, for anyone who wants to evaluate a snapshot they hold.
export {
  BUCKET_SPACE,
  WEIGHT_SCALE,
  bucket,
  evaluate,
  evaluateFlag,
  hasRollout,
  isValidContextKey,
  sdkDefault,
  validateRollout,
  validateRolloutWeights,
  type RolloutRejection,
  type RolloutValidation,
} from './evaluation/index.js';

export type * from './types.js';
