/**
 * Hand-written TS mirrors of the backend contract
 * (backend/src/main/resources/openapi/switchboard-api.yaml, v0.1.0).
 * This file is CANONICAL in the app — features re-export from here.
 * Update alongside the spec; do not fork shapes per feature.
 */

// ---------- Errors ----------

export type ApiErrorCode =
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'VALIDATION_FAILED'
  | 'UNAUTHORIZED'
  | 'AI_UNAVAILABLE'
  | 'UPGRADE_REQUIRED';

export interface ApiError {
  error: ApiErrorCode;
  message: string;
}

// ---------- Users / Orgs ----------

export type OrgRole = 'OWNER' | 'MEMBER';

export interface UserMembership {
  orgId: string;
  orgName: string;
  orgSlug: string;
  role: OrgRole;
}

export interface UserResponse {
  id: string;
  email: string;
  displayName?: string;
  onboardingCompleted: boolean;
  memberships: UserMembership[];
}

export interface OrgResponse {
  id: string;
  name: string;
  slug: string;
  role: OrgRole;
  createdAt: string;
}

export interface OrgMemberResponse {
  userId: string;
  email: string;
  displayName?: string;
  role: OrgRole;
  joinedAt: string;
}

export interface OrgMemberAddRequest {
  email: string;
  role: OrgRole;
}

export interface OrgSettingsResponse {
  aiEnabled: boolean;
  autoRollbackEnabled: boolean;
  autoOptimizeEnabled: boolean;
  staleFlagWeeks: number;
  notificationWebhookSet?: boolean;
}

export interface OrgSettingsUpdateRequest {
  aiEnabled?: boolean;
  autoRollbackEnabled?: boolean;
  autoOptimizeEnabled?: boolean;
  /** 1-52. */
  staleFlagWeeks?: number;
  notificationWebhookUrl?: string;
}

// ---------- Projects / Environments ----------

export interface EnvironmentResponse {
  id: string;
  projectId: string;
  key: string;
  name: string;
  stateVersion: number;
}

export interface ProjectResponse {
  id: string;
  orgId: string;
  key: string;
  name: string;
  environments: EnvironmentResponse[];
}

export interface ProjectCreateRequest {
  key: string;
  name: string;
}

export interface ProjectUpdateRequest {
  name?: string;
}

// ---------- SDK keys ----------

export interface SdkKeyCreateRequest {
  label?: string;
}

export interface SdkKeyResponse {
  id: string;
  environmentId: string;
  keyPrefix: string;
  label?: string;
  createdAt: string;
  revokedAt?: string;
}

export interface SdkKeyCreatedResponse {
  id: string;
  environmentId: string;
  /** Full SDK key. Returned only at creation. */
  key: string;
  keyPrefix: string;
  label?: string;
  createdAt: string;
}

// ---------- Flags ----------

export type FlagKind = 'BOOLEAN' | 'STRING';

export interface Variation {
  id: string;
  value: string;
  name?: string;
}

export interface VariationCreate {
  value: string;
  name?: string;
}

export type ClauseOp =
  | 'EQUALS'
  | 'IN'
  | 'CONTAINS'
  | 'STARTS_WITH'
  | 'SEGMENT_MATCH'
  | 'NOT_SEGMENT_MATCH';

export interface Clause {
  /** Context attribute name; 'key' targets the context key. SEGMENT_MATCH ops carry segment keys in values. */
  attribute: string;
  op: ClauseOp;
  values: string[];
}

export interface WeightedVariation {
  variationId: string;
  /** 0-100. */
  weight: number;
}

/** Exactly one of variationId or rollout must be set. Rollout weights sum to 100. */
export interface RolloutOrVariation {
  variationId?: string;
  rollout?: WeightedVariation[];
}

export interface IndividualTarget {
  contextKey: string;
  variationId: string;
}

export interface Rule {
  id: string;
  description?: string;
  clauses: Clause[];
  serve: RolloutOrVariation;
}

export interface FlagTargetingConfig {
  individualTargets?: IndividualTarget[];
  rules?: Rule[];
  fallthrough: RolloutOrVariation;
  offVariationId: string;
  defaultVariationId: string;
}

export interface FlagEnvConfigResponse {
  flagId: string;
  environmentId: string;
  envKey: string;
  enabled: boolean;
  killSwitchActive: boolean;
  config: FlagTargetingConfig;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

export interface FlagDetailResponse {
  id: string;
  projectId: string;
  key: string;
  name: string;
  description?: string;
  kind: FlagKind;
  variations: Variation[];
  tags: string[];
  envConfigs: FlagEnvConfigResponse[];
  createdAt?: string;
}

export interface FlagEnvSummary {
  envKey: string;
  enabled: boolean;
  killSwitchActive: boolean;
  /** Percent of traffic on a non-default variation when fallthrough is a rollout; absent otherwise. */
  rolloutPercentage?: number;
  version: number;
  updatedAt?: string;
  updatedBy?: string;
}

export interface FlagSummaryResponse {
  id: string;
  key: string;
  name: string;
  kind: FlagKind;
  tags: string[];
  environments: FlagEnvSummary[];
}

export interface FlagListResponse {
  items: FlagSummaryResponse[];
  nextCursor?: string;
}

export interface FlagVersionResponse {
  versionNumber: number;
  enabled: boolean;
  killSwitchActive: boolean;
  config: FlagTargetingConfig;
  versionNote?: string;
  createdBy: string;
  createdFromProposalId?: string;
  createdAt: string;
}

export interface FlagVersionListResponse {
  items: FlagVersionResponse[];
  nextCursor?: string;
}

// ---------- Flag write requests ----------

export interface FlagCreateRequest {
  /** ^[a-z][a-z0-9-]*$, max 128. */
  key: string;
  name: string;
  description?: string;
  kind: FlagKind;
  /** Required for STRING flags; ignored for BOOLEAN (always true/false). */
  variations?: VariationCreate[];
  tags?: string[];
}

export interface FlagUpdateRequest {
  name?: string;
  description?: string;
  tags?: string[];
  /** STRING flags only; variations are add-only. */
  addVariations?: VariationCreate[];
}

export interface FlagEnvConfigUpdateRequest {
  enabled: boolean;
  config: FlagTargetingConfig;
  /** Optimistic concurrency; 409 CONFLICT when stale. Omit to force-write. */
  expectedVersion?: number;
  comment?: string;
}

export interface KillSwitchRequest {
  active: boolean;
  reason?: string;
}

export interface RollbackRequest {
  toVersion: number;
  reason?: string;
}

// ---------- Segments ----------

export interface SegmentRule {
  clauses: Clause[];
}

export interface SegmentResponse {
  id: string;
  projectId: string;
  key: string;
  name: string;
  includedKeys: string[];
  excludedKeys: string[];
  rules: SegmentRule[];
  updatedAt?: string;
}

// ---------- Audit ----------

export type AuditAction =
  | 'CREATE'
  | 'UPDATE'
  | 'KILL_SWITCH_ON'
  | 'KILL_SWITCH_OFF'
  | 'ROLLBACK'
  | 'AI_APPLY'
  | 'ARCHIVE'
  | 'SEGMENT_CREATE'
  | 'SEGMENT_UPDATE'
  | 'SEGMENT_DELETE'
  | 'SDK_KEY_CREATE'
  | 'SDK_KEY_REVOKE'
  | 'MEMBER_ADD'
  | 'MEMBER_REMOVE'
  | 'SETTINGS_UPDATE';

export interface AuditEntryResponse {
  id: string;
  orgId: string;
  projectId?: string;
  environmentId?: string;
  envKey?: string;
  flagKey?: string;
  action: AuditAction;
  actor: string;
  reason?: string;
  versionFrom?: number;
  versionTo?: number;
  createdAt: string;
}

export interface AuditListResponse {
  items: AuditEntryResponse[];
  nextCursor?: string;
}

// ---------- Evaluation ----------

export interface EvalContext {
  /** Stable context key (e.g. user id). Bucketing input. */
  key: string;
  attributes?: Record<string, string>;
}

export type EvalReason =
  | 'KILL_SWITCH'
  | 'FLAG_OFF'
  | 'TARGET_MATCH'
  | 'RULE_MATCH'
  | 'ROLLOUT'
  | 'DEFAULT'
  | 'SDK_DEFAULT';

export interface EvalResult {
  flagKey: string;
  variationId?: string;
  /** Variation value; boolean flags serve "true"/"false". */
  value: string;
  reason: EvalReason;
  ruleId?: string;
  flagVersion?: number;
}

// ---------- AI proposals ----------

export type ProposalKind = 'FLAG_CREATE' | 'FLAG_UPDATE' | 'ROLLBACK' | 'RETIREMENT';

export type ProposalStatus = 'DRAFT' | 'APPLIED' | 'REJECTED' | 'EXPIRED';

export interface EnvChange {
  envKey: string;
  enabled?: boolean;
  killSwitchActive?: boolean;
  config?: FlagTargetingConfig;
}

export interface FlagChangeDiff {
  kind: ProposalKind;
  flagKey: string;
  name?: string;
  description?: string;
  flagKind?: FlagKind;
  variations?: VariationCreate[];
  tags?: string[];
  envChanges?: EnvChange[];
  rollbackToVersion?: number;
  retirementChecklist?: string[];
}

export interface ProposalDraftRequest {
  /** 1-2000 chars. */
  prompt: string;
  /** Narrows the proposal to one environment. */
  environmentKey?: string;
  /** Set when the prompt edits an existing flag. */
  flagKey?: string;
}

export interface ProposalActionRequest {
  reason?: string;
}

export interface AiProposalResponse {
  id: string;
  orgId: string;
  projectId: string;
  environmentId?: string;
  kind: ProposalKind;
  sourcePrompt?: string;
  diff: FlagChangeDiff;
  rationale?: string;
  status: ProposalStatus;
  createdBy: string;
  appliedBy?: string;
  appliedVersion?: number;
  createdAt: string;
}

export interface AiProposalListResponse {
  items: AiProposalResponse[];
  nextCursor?: string;
}

// ---------- Monitoring ----------

export type AnomalyStatus = 'OPEN' | 'ACKED' | 'AUTO_ROLLED_BACK';

export interface AnomalyFindingResponse {
  id: string;
  environmentId: string;
  flagKey: string;
  variationId?: string;
  metricKey: string;
  baselineRate: number;
  variantRate: number;
  zScore: number;
  summary?: string;
  status: AnomalyStatus;
  suggestedProposalId?: string;
  createdAt: string;
}

export interface VariantStats {
  variationId: string;
  variationName?: string;
  evalCount: number;
  errorRate: number;
  conversionRate: number;
}

export interface RolloutStatsBucket {
  bucketStart: string;
  variants: VariantStats[];
}

export interface RolloutStatsResponse {
  flagKey: string;
  environmentId: string;
  totals: VariantStats[];
  buckets: RolloutStatsBucket[];
}
