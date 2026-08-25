import type { AttributeValue, Clause, EvalContext, Segment } from '../types.js';
import { matchesOne } from './compare.js';

/** The reserved attribute name that reads the context key instead of the attributes map. */
export const KEY_ATTRIBUTE = 'key';

function isSegmentOp(clause: Clause): boolean {
  return clause.op === 'SEGMENT_MATCH' || clause.op === 'NOT_SEGMENT_MATCH';
}

/**
 * `NOT_SEGMENT_MATCH` predates per-clause negation and still appears in stored configs. Folding it
 * into `SEGMENT_MATCH` + negate here means one code path serves both, and a config written before
 * negation existed evaluates identically without being rewritten under anyone.
 */
function normalise(clause: Clause): Clause {
  if (clause.op !== 'NOT_SEGMENT_MATCH') return clause;
  return { ...clause, op: 'SEGMENT_MATCH', negate: !clause.negate };
}

/**
 * Reads the value a non-segment clause compares against (spec/evaluation.md 3.1).
 *
 * The literal attribute name `key` reads `context.key`; an entry actually named `key` inside the
 * attributes map is unreachable. A missing attribute returns undefined, which FAILS the clause —
 * before negation, which the caller applies afterwards.
 *
 * `null` is absent, and so is a nested object: no operator can act on one, and inventing a coercion
 * would invent matches.
 */
function readAttribute(clause: Clause, context: EvalContext): AttributeValue | undefined {
  if (clause.attribute === KEY_ATTRIBUTE) {
    return context.key;
  }
  const value = context.attributes?.[clause.attribute];
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'object' && !Array.isArray(value)) return undefined;
  return value;
}

/** An array's elements, or the value itself. Every operator is existential over an array. */
function elements(value: AttributeValue): AttributeValue[] {
  if (!Array.isArray(value)) return [value];
  // Nested arrays are flattened: the operators are already existential, so flattening keeps that
  // one rule true at any depth.
  return value.flat(Infinity) as AttributeValue[];
}

/**
 * Matches an attribute clause, BEFORE negation.
 *
 * Doubly existential: any element of an array attribute against any listed value. A clause with an
 * empty `values` list never matches, because every operator is an any-of over `values`.
 */
export function attributeClauseMatches(clause: Clause, context: EvalContext): boolean {
  const attribute = readAttribute(clause, context);
  if (attribute === undefined) {
    return false;
  }
  return elements(attribute).some((element) =>
    clause.values.some((value) => matchesOne(clause.op, element, value)),
  );
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
  for (const raw of clauses) {
    const clause = normalise(raw);
    // A nested segment clause fails OUTRIGHT — negation must not turn a refusal to follow a
    // configuration into a match (spec 4.2).
    if (isSegmentOp(clause)) {
      return false;
    }
    if (Boolean(clause.negate) === attributeClauseMatches(clause, context)) {
      return false;
    }
  }
  return true;
}

/**
 * Matches one flag-rule clause, with negation applied last (spec/evaluation.md 3.2, 3.3).
 *
 * Negation inverts the missing-attribute case too, so a negated clause on a missing attribute is
 * TRUE. It also inverts the segment failure modes: an unknown segment key never matches, so a
 * negated SEGMENT_MATCH over an unknown key MATCHES.
 */
export function clauseMatches(
  raw: Clause,
  context: EvalContext,
  segmentsByKey: ReadonlyMap<string, Segment>,
): boolean {
  const clause = normalise(raw);
  const matched = isSegmentOp(clause)
    ? anySegmentMatches(clause.values, context, segmentsByKey)
    : attributeClauseMatches(clause, context);
  return Boolean(clause.negate) !== matched;
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
