import type { Clause, EvalContext, Segment } from '../types.js';

/** The reserved attribute name that reads the context key instead of the attributes map. */
export const KEY_ATTRIBUTE = 'key';

function isSegmentOp(clause: Clause): boolean {
  return clause.op === 'SEGMENT_MATCH' || clause.op === 'NOT_SEGMENT_MATCH';
}

/**
 * Reads the string a non-segment clause compares against (spec/evaluation.md 3.1).
 *
 * The literal attribute name `key` reads `context.key`; an entry actually named `key` inside the
 * attributes map is unreachable. A missing attribute returns undefined, which FAILS the clause.
 */
function readAttribute(clause: Clause, context: EvalContext): string | undefined {
  if (clause.attribute === KEY_ATTRIBUTE) {
    return context.key;
  }
  return context.attributes?.[clause.attribute];
}

/**
 * Matches an attribute clause. Comparisons are byte-for-byte on the string and case-sensitive;
 * there is no coercion, no numeric comparison and no locale folding (spec/evaluation.md 1.1).
 *
 * A clause with an empty `values` list never matches, because every operator is an any-of over
 * `values`.
 */
export function attributeClauseMatches(clause: Clause, context: EvalContext): boolean {
  const attribute = readAttribute(clause, context);
  if (attribute === undefined) {
    return false;
  }
  switch (clause.op) {
    case 'EQUALS':
    case 'IN':
      return clause.values.some((value) => attribute === value);
    case 'CONTAINS':
      return clause.values.some((value) => attribute.includes(value));
    case 'STARTS_WITH':
      return clause.values.some((value) => attribute.startsWith(value));
    default:
      // SEGMENT_MATCH / NOT_SEGMENT_MATCH are not attribute clauses.
      return false;
  }
}

/**
 * True when ANY named segment matches. An unknown segment key simply does not match; it is never
 * an error (spec/evaluation.md 4).
 */
function anySegmentMatches(
  segmentKeys: readonly string[],
  context: EvalContext,
  segmentsByKey: ReadonlyMap<string, Segment>,
): boolean {
  for (const key of segmentKeys) {
    const segment = segmentsByKey.get(key);
    if (segment !== undefined && segmentMatches(segment, context)) {
      return true;
    }
  }
  return false;
}

/**
 * Segment membership: excluded beats included beats rules (spec/evaluation.md 4.1).
 *
 * A key in both `includedKeys` and `excludedKeys` is excluded.
 */
export function segmentMatches(segment: Segment, context: EvalContext): boolean {
  if (segment.excludedKeys?.includes(context.key)) {
    return false;
  }
  if (segment.includedKeys?.includes(context.key)) {
    return true;
  }
  for (const rule of segment.rules ?? []) {
    if (segmentRuleMatches(rule.clauses, context)) {
      return true;
    }
  }
  return false;
}

/**
 * Segment rules support attribute clauses only. A nested `SEGMENT_MATCH` / `NOT_SEGMENT_MATCH`
 * clause FAILS, which fails its rule, so segment evaluation is non-recursive and cannot cycle
 * (spec/evaluation.md 4.2).
 */
function segmentRuleMatches(clauses: readonly Clause[], context: EvalContext): boolean {
  for (const clause of clauses) {
    if (isSegmentOp(clause) || !attributeClauseMatches(clause, context)) {
      return false;
    }
  }
  return true;
}

/** Matches one flag-rule clause, dispatching the segment operators (spec/evaluation.md 3.2). */
export function clauseMatches(
  clause: Clause,
  context: EvalContext,
  segmentsByKey: ReadonlyMap<string, Segment>,
): boolean {
  switch (clause.op) {
    case 'SEGMENT_MATCH':
      return anySegmentMatches(clause.values, context, segmentsByKey);
    case 'NOT_SEGMENT_MATCH':
      // The exact logical negation of SEGMENT_MATCH, including its failure modes: an unknown
      // segment key does not match, so NOT_SEGMENT_MATCH over an unknown key MATCHES.
      return !anySegmentMatches(clause.values, context, segmentsByKey);
    default:
      return attributeClauseMatches(clause, context);
  }
}

/**
 * A rule matches when ALL of its clauses match. An empty clause list matches every context - that
 * is the "serve everyone" rule the dashboard writes for a plain rollout (spec/evaluation.md 3).
 */
export function allClausesMatch(
  clauses: readonly Clause[],
  context: EvalContext,
  segmentsByKey: ReadonlyMap<string, Segment>,
): boolean {
  for (const clause of clauses) {
    if (!clauseMatches(clause, context, segmentsByKey)) {
      return false;
    }
  }
  return true;
}
