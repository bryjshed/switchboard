/**
 * Wire and evaluation types for Switchboard.
 *
 * These mirror `backend/src/main/resources/openapi/switchboard-api.yaml` and the data model in
 * `spec/evaluation.md` sections 1.1 - 1.3. Field names match the wire exactly so a bootstrap or
 * SSE payload can be used as-is with no mapping layer.
 */

/** Flag kind. Metadata only: it never changes evaluation (spec/evaluation.md 1.2). */
export type FlagKind = 'BOOLEAN' | 'STRING';

/** The six clause operators (spec/evaluation.md 3.2). */
export type ClauseOp =
  // Text
  | 'EQUALS'
  | 'IN'
  | 'CONTAINS'
  | 'STARTS_WITH'
  | 'ENDS_WITH'
  | 'MATCHES'
  // Numeric
  | 'GREATER_THAN'
  | 'GREATER_THAN_OR_EQUAL'
  | 'LESS_THAN'
  | 'LESS_THAN_OR_EQUAL'
  // Time
  | 'BEFORE'
  | 'AFTER'
  // Versions
  | 'SEMVER_EQUAL'
  | 'SEMVER_GREATER_THAN'
  | 'SEMVER_LESS_THAN'
  // Segments. NOT_SEGMENT_MATCH is deprecated in favour of SEGMENT_MATCH + negate, and is
  // normalised to exactly that on read so old configs keep evaluating identically.
  | 'SEGMENT_MATCH'
  | 'NOT_SEGMENT_MATCH';

/**
 * An attribute value.
 *
 * Typed, because that is what callers have: an app version is a string, a cart total is a number.
 * Clause values stay strings — the OPERATOR decides how both sides are read. See
 * spec/evaluation.md 3.1.
 */
export type AttributeValue = string | number | boolean | Array<string | number | boolean>;

/** Why a value was served (spec/evaluation.md 1.3). */
export type EvalReason =
  | 'KILL_SWITCH'
  | 'FLAG_OFF'
  | 'TARGET_MATCH'
  | 'RULE_MATCH'
  | 'ROLLOUT'
  | 'DEFAULT'
  | 'SDK_DEFAULT';

export interface Variation {
  id: string;
  value: string;
  name?: string | null;
}

export interface Clause {
  /** Attribute name; the literal `key` reads the context key. Ignored for the segment operators. */
  attribute: string;
  op: ClauseOp;
  /** Values to test against, or segment keys for the segment operators. Empty never matches. */
  values: string[];
  /**
   * Inverts the clause, INCLUDING the missing-attribute case: a negated clause on a missing
   * attribute is TRUE. "plan is not free" holds for somebody with no plan at all. Matches
   * LaunchDarkly; pinned by conformance vectors because it surprises people.
   */
  negate?: boolean;
}

export interface WeightedVariation {
  variationId: string;
  /** Whole percent in [0, 100]. The weights of one rollout must sum to exactly 100. */
  weight: number;
}

/**
 * Exactly one of `variationId` or a non-empty `rollout` is meaningful.
 *
 * The server serialises both fields on every serve, leaving the unused one as `null` / `[]`,
 * so "has a rollout" means "rollout is a non-empty array" - never "rollout is present".
 */
export interface RolloutOrVariation {
  variationId?: string | null;
  rollout?: WeightedVariation[] | null;
}

export interface Rule {
  id: string;
  description?: string | null;
  clauses: Clause[];
  serve: RolloutOrVariation;
}

export interface IndividualTarget {
  contextKey: string;
  variationId: string;
}

export interface TargetingConfig {
  individualTargets?: IndividualTarget[] | null;
  rules?: Rule[] | null;
  fallthrough: RolloutOrVariation;
  offVariationId: string;
  /** Dashboard metadata for new environments. NEVER consulted during evaluation. */
  defaultVariationId?: string | null;
}

/** A flag plus its config in one environment, exactly as `GET /api/eval/bootstrap` returns it. */
export interface Flag {
  key: string;
  kind: FlagKind;
  variations: Variation[];
  enabled: boolean;
  killSwitchActive: boolean;
  config: TargetingConfig;
  version?: number;
}

export interface SegmentRule {
  clauses: Clause[];
}

export interface Segment {
  key: string;
  includedKeys?: string[] | null;
  excludedKeys?: string[] | null;
  rules?: SegmentRule[] | null;
}

/** The subject of an evaluation (spec/evaluation.md 1.1). */
export interface EvalContext {
  /** Stable identifier; the bucketing input. Must be non-empty and not whitespace-only. */
  key: string;
  /**
   * Typed attributes. null and nested objects are treated as absent; nested arrays are flattened.
   * Every operator matches existentially over an array.
   */
  attributes?: Record<string, AttributeValue | null | undefined>;
}

/** The result of evaluating one flag for one context (spec/evaluation.md 1.3). */
export interface EvalOutcome {
  variationId: string | null;
  /** The matched variation's value, or null when `variationId` names no defined variation. */
  value: string | null;
  reason: EvalReason;
  /** Set if and only if `reason` is `RULE_MATCH`. */
  ruleId: string | null;
}

/** `GET /api/eval/bootstrap` response body. */
export interface BootstrapResponse {
  envKey: string;
  stateVersion: number;
  flags: Flag[];
  segments: Segment[];
}

/** SSE `patch` event body: one flag's environment config, without variations or kind. */
export interface PatchEvent {
  flagKey: string;
  enabled: boolean;
  killSwitchActive: boolean;
  config: TargetingConfig;
  version?: number;
  stateVersion: number;
}

/** `POST /api/eval/{flagKey}` and `POST /api/eval` result element. */
export interface ServerEvalResult {
  flagKey: string;
  variationId?: string | null;
  value: string;
  reason: EvalReason;
  ruleId?: string | null;
  flagVersion?: number;
}

export interface ServerBulkEvalResponse {
  stateVersion: number;
  results: ServerEvalResult[];
}

/** `POST /api/events/eval` item. */
export interface EvalEventItem {
  flagKey: string;
  contextKey: string;
  variationId?: string | null;
  reason?: EvalReason;
  occurredAt: string;
}

/** `POST /api/events/metrics` item. */
export interface MetricEventItem {
  contextKey: string;
  metricKey: string;
  value?: number;
  occurredAt: string;
}


// ---------------------------------------------------------------- client mode

/**
 * One evaluated flag from `POST /api/eval/bootstrap`.
 *
 * Note what is NOT here: no `config`, no `variations`, no segments. A client key receives values,
 * never the rules that produced them - see the SDK README's client-mode section.
 */
export interface ClientBootstrapFlag {
  key: string;
  kind: FlagKind;
  value: string;
  variationId?: string | null;
  variationName?: string | null;
  reason: EvalReason;
  ruleId?: string | null;
  version?: number;
}

export interface ClientBootstrapResponse {
  envKey: string;
  stateVersion: number;
  /**
   * Hex SHA-256 of the canonicalised context this payload was evaluated for. The client discards a
   * payload whose hash does not match the context it sent, which is what stops a 304 from being
   * applied across a `setContext()`.
   */
  contextHash: string;
  flags: ClientBootstrapFlag[];
}
