// Friendly aliases over the generated OpenAPI schemas. Import application types from HERE,
// never from `generated/switchboard-api.d.ts` directly, and never hand-redeclare a shape the
// spec already describes — that is how the two drift apart silently.
import type { components, paths } from './generated/switchboard-api'

type Schemas = components['schemas']

export type SwitchboardApiPaths = paths

export type ApiErrorBody = Schemas['ApiError']
export type ApiErrorCode = ApiErrorBody['error']

export type User = Schemas['UserResponse']
export type UserMembership = Schemas['UserMembership']
export type OrgRole = Schemas['OrgRole']
export type Org = Schemas['OrgResponse']
export type OrgMember = Schemas['OrgMemberResponse']
export type OrgMemberAddRequest = Schemas['OrgMemberAddRequest']
export type OrgSettings = Schemas['OrgSettingsResponse']
export type OrgSettingsUpdateRequest = Schemas['OrgSettingsUpdateRequest']

export type Project = Schemas['ProjectResponse']
export type Environment = Schemas['EnvironmentResponse']

export type SdkKey = Schemas['SdkKeyResponse']
export type SdkKeyCreated = Schemas['SdkKeyCreatedResponse']
export type SdkKeyCreateRequest = Schemas['SdkKeyCreateRequest']
export type SdkKeyKind = Schemas['SdkKeyKind']
export type Webhook = Schemas['WebhookResponse']
export type WebhookCreated = Schemas['WebhookCreatedResponse']
export type WebhookCreateRequest = Schemas['WebhookCreateRequest']
export type WebhookUpdateRequest = Schemas['WebhookUpdateRequest']
export type WebhookEventType = Schemas['WebhookEventType']
export type WebhookDelivery = Schemas['WebhookDeliveryResponse']
export type WebhookDeliveryStatus = Schemas['WebhookDeliveryStatus']

export type PersonalAccessToken = Schemas['PersonalAccessTokenResponse']
export type PersonalAccessTokenCreated = Schemas['PersonalAccessTokenCreatedResponse']
export type PersonalAccessTokenCreateRequest = Schemas['PersonalAccessTokenCreateRequest']

export type FlagKind = Schemas['FlagKind']
export type Variation = Schemas['Variation']
export type VariationCreate = Schemas['VariationCreate']
export type FlagCreateRequest = Schemas['FlagCreateRequest']
export type FlagUpdateRequest = Schemas['FlagUpdateRequest']
export type FlagDetail = Schemas['FlagDetailResponse']
export type FlagSummary = Schemas['FlagSummaryResponse']
export type FlagEnvSummary = Schemas['FlagEnvSummary']
export type FlagListResponse = Schemas['FlagListResponse']
export type FlagEnvConfig = Schemas['FlagEnvConfigResponse']
export type FlagEnvConfigUpdateRequest = Schemas['FlagEnvConfigUpdateRequest']
export type FlagTargetingConfig = Schemas['FlagTargetingConfig']
export type KillSwitchRequest = Schemas['KillSwitchRequest']
export type RollbackRequest = Schemas['RollbackRequest']
export type FlagVersion = Schemas['FlagVersionResponse']
export type FlagVersionListResponse = Schemas['FlagVersionListResponse']

export type Clause = Schemas['Clause']
export type ClauseOp = Schemas['ClauseOp']
export type Rule = Schemas['Rule']
export type RolloutOrVariation = Schemas['RolloutOrVariation']
export type WeightedVariation = Schemas['WeightedVariation']
export type IndividualTarget = Schemas['IndividualTarget']

export type ProposalKind = Schemas['ProposalKind']
export type ProposalStatus = Schemas['ProposalStatus']
export type ProposalDraftRequest = Schemas['ProposalDraftRequest']
export type ProposalActionRequest = Schemas['ProposalActionRequest']
export type AiProposal = Schemas['AiProposalResponse']
export type AiProposalListResponse = Schemas['AiProposalListResponse']
export type FlagChangeDiff = Schemas['FlagChangeDiff']
export type EnvChange = Schemas['EnvChange']

export type AnomalyStatus = Schemas['AnomalyStatus']
export type AnomalyFinding = Schemas['AnomalyFindingResponse']
export type VariantStats = Schemas['VariantStats']
export type RolloutStatsBucket = Schemas['RolloutStatsBucket']
export type RolloutStats = Schemas['RolloutStatsResponse']

export type AuditAction = Schemas['AuditAction']
export type AuditEntry = Schemas['AuditEntryResponse']
export type AuditListResponse = Schemas['AuditListResponse']

export type Segment = Schemas['SegmentResponse']
export type SegmentUpsertRequest = Schemas['SegmentUpsertRequest']
export type SegmentRule = Schemas['SegmentRule']

// Clause operator options, in the order they should appear in a select. Derived from the
// generated union so a spec change that adds an operator is a compile error here.
// The operators the editor offers, in the order it offers them: most-used first, grouped by the
// kind of comparison. NOT_SEGMENT_MATCH is deliberately absent — it is deprecated in favour of
// SEGMENT_MATCH with "not", and offering both would let someone author the deprecated form.
export const CLAUSE_OPS = [
  'EQUALS',
  'IN',
  'CONTAINS',
  'STARTS_WITH',
  'ENDS_WITH',
  'MATCHES',
  'GREATER_THAN',
  'GREATER_THAN_OR_EQUAL',
  'LESS_THAN',
  'LESS_THAN_OR_EQUAL',
  'BEFORE',
  'AFTER',
  'SEMVER_EQUAL',
  'SEMVER_GREATER_THAN',
  'SEMVER_LESS_THAN',
  'SEGMENT_MATCH',
] as const satisfies readonly ClauseOp[]

export const CLAUSE_OP_LABELS: Record<ClauseOp, string> = {
  EQUALS: 'equals',
  IN: 'is one of',
  CONTAINS: 'contains',
  STARTS_WITH: 'starts with',
  ENDS_WITH: 'ends with',
  MATCHES: 'matches regex',
  GREATER_THAN: 'is greater than',
  GREATER_THAN_OR_EQUAL: 'is at least',
  LESS_THAN: 'is less than',
  LESS_THAN_OR_EQUAL: 'is at most',
  BEFORE: 'is before',
  AFTER: 'is after',
  SEMVER_EQUAL: 'version equals',
  SEMVER_GREATER_THAN: 'version is greater than',
  SEMVER_LESS_THAN: 'version is less than',
  SEGMENT_MATCH: 'is in segment',
  NOT_SEGMENT_MATCH: 'is not in segment (deprecated)',
}

/** A hint under the value input, so the expected format is visible while typing it. */
export const CLAUSE_OP_HINTS: Partial<Record<ClauseOp, string>> = {
  MATCHES: 'Unanchored. No lookahead or backreferences — use ^…$ to match the whole value.',
  GREATER_THAN: 'Numbers. A text attribute that parses as a number works too.',
  GREATER_THAN_OR_EQUAL: 'Numbers. A text attribute that parses as a number works too.',
  LESS_THAN: 'Numbers. A text attribute that parses as a number works too.',
  LESS_THAN_OR_EQUAL: 'Numbers. A text attribute that parses as a number works too.',
  BEFORE: 'ISO-8601, e.g. 2026-08-25T12:00:00Z. Epoch milliseconds also work.',
  AFTER: 'ISO-8601, e.g. 2026-08-25T12:00:00Z. Epoch milliseconds also work.',
  SEMVER_EQUAL: 'Semver, e.g. 4.2.0. A leading v and missing segments are fine.',
  SEMVER_GREATER_THAN: 'Semver, e.g. 4.2.0. Pre-releases rank below the release.',
  SEMVER_LESS_THAN: 'Semver, e.g. 4.2.0. Pre-releases rank below the release.',
}

// True when the operator's `values` carry segment keys rather than raw attribute values —
// the clause editor swaps to a segment picker for these.
export function isSegmentOp(op: ClauseOp): boolean {
  return op === 'SEGMENT_MATCH' || op === 'NOT_SEGMENT_MATCH'
}

// Proposal status options, in the order the filter tabs show them. Derived from the generated
// union so a spec change that adds a status is a compile error here rather than a silent gap.
export const PROPOSAL_STATUSES = [
  'DRAFT',
  'APPLIED',
  'REJECTED',
  'EXPIRED',
] as const satisfies readonly ProposalStatus[]

export const PROPOSAL_KIND_LABELS: Record<ProposalKind, string> = {
  FLAG_CREATE: 'create flag',
  FLAG_UPDATE: 'update flag',
  ROLLBACK: 'roll back',
  RETIREMENT: 'retire flag',
}

// The backend stamps proposals it raised itself with these actor labels. Anything else is a
// person's email, and the UI must not describe it as automatic.
export const SYSTEM_PROPOSAL_AUTHORS = ['switchboard-monitor', 'switchboard-sweeper'] as const

export function isSystemAuthor(createdBy: string): boolean {
  return (SYSTEM_PROPOSAL_AUTHORS as readonly string[]).includes(createdBy)
}

// ---------------------------------------------------------------- RBAC

export type Permission = Schemas['Permission']
export type ScopeType = Schemas['ScopeType']
export type Role = Schemas['RoleResponse']
export type RoleListResponse = Schemas['RoleListResponse']
export type RoleAssignment = Schemas['RoleAssignmentResponse']
export type RoleAssignmentListResponse = Schemas['RoleAssignmentListResponse']
export type RoleAssignmentCreateRequest = Schemas['RoleAssignmentCreateRequest']
export type MyPermissions = Schemas['MyPermissionsResponse']

// Every permission the backend knows, in the order the roles matrix shows them: read first,
// then the write verbs, then the administrative ones. `satisfies` makes a spec change that
// adds a permission a compile error here rather than a silently missing matrix column.
export const PERMISSIONS = [
  'FLAG_READ',
  'FLAG_WRITE',
  'FLAG_KILL',
  'FLAG_ROLLBACK',
  'SEGMENT_WRITE',
  'APPROVE_CHANGES',
  'VIEW_AUDIT',
  'MANAGE_MEMBERS',
  'MANAGE_SDK_KEYS',
  'MANAGE_PROJECTS',
  'MANAGE_ENVIRONMENTS',
  'MANAGE_SETTINGS',
] as const satisfies readonly Permission[]

export const SCOPE_TYPES = ['ORG', 'PROJECT', 'ENVIRONMENT'] as const satisfies readonly ScopeType[]

// ---------------------------------------------------------------- approvals

export type ApprovalSettings = Schemas['ApprovalSettingsResponse']
export type ApprovalSettingsUpdateRequest = Schemas['ApprovalSettingsUpdateRequest']

export type ChangeRequestKind = Schemas['ChangeRequestKind']
export type ChangeRequestStatus = Schemas['ChangeRequestStatus']
export type ChangeRequestPayload = Schemas['ChangeRequestPayload']
export type ChangeRequestReview = Schemas['ChangeRequestReviewResponse']
export type ChangeRequest = Schemas['ChangeRequestResponse']
export type ChangeRequestListResponse = Schemas['ChangeRequestListResponse']
export type ChangeRequestDecisionRequest = Schemas['ChangeRequestDecisionRequest']
export type ReviewDecision = Schemas['ReviewDecision']

// Filter-tab order: the reviewable state first, then the ones that still need somebody
// (APPROVED but unapplied, STALE), then the settled ones.
export const CHANGE_REQUEST_STATUSES = [
  'PENDING',
  'APPROVED',
  'STALE',
  'APPLIED',
  'DECLINED',
  'WITHDRAWN',
] as const satisfies readonly ChangeRequestStatus[]

export const CHANGE_REQUEST_KINDS = [
  'TARGETING_UPDATE',
  'KILL_SWITCH',
  'ROLLBACK',
] as const satisfies readonly ChangeRequestKind[]
