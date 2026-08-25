import type { AttributeValue, ClauseOp } from '../types.js';

/**
 * Comparing one attribute against one clause value, per spec/evaluation.md 3.2.
 *
 * This is the mirror of the server's `ClauseMatcher`, and every rule in it exists so that the two
 * cannot disagree. Where a platform default would be more convenient but less portable, the
 * portable rule wins — see `asInstant` and `regexMatches` in particular.
 *
 * Nothing throws. A value that cannot be read as the operator needs makes the clause false, never
 * an error: a flag system that can fail a request because somebody typed a bad number into a rule
 * is worse than one that quietly does not match.
 */

/** Canonical text. An integral number has no trailing `.0`, so the number 4 is the text "4". */
export function asText(value: AttributeValue): string | null {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') {
    return Number.isFinite(value) ? String(value) : null;
  }
  // An array has no single text; only its elements do.
  return null;
}

export function asNumber(value: AttributeValue | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/**
 * ISO-8601 date-time, strictly — deliberately NOT `Date.parse` on arbitrary text.
 *
 * `Date.parse` is implementation-defined outside ISO-8601, and V8 reads `"4.2.0"` as 2 April 2000
 * where a strict parser rejects it. Using it here would mean a `BEFORE` rule matching in a browser
 * and not on the server. The conformance vectors caught exactly that during the operator work.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

export function asInstant(value: AttributeValue | string): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = asText(value as AttributeValue);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (ISO_INSTANT.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  // The only other accepted form is a number read as epoch milliseconds.
  return asNumber(trimmed);
}

// ---------------------------------------------------------------------------------------------
// Semver
// ---------------------------------------------------------------------------------------------

interface Semver {
  major: number;
  minor: number;
  patch: number;
  pre: string[];
}

function numericIdentifier(text: string): number | null {
  if (!/^[0-9]+$/.test(text)) return null;
  // Leading zeros are not a numeric identifier in semver 2.0.0.
  if (text.length > 1 && text.startsWith('0')) return null;
  return Number(text);
}

/**
 * Lenient about a leading `v` and missing segments, because `4`, `v4.2` and `4.2.0` all turn up in
 * real user agents. Strict about everything else; build metadata is discarded because semver 2.0.0
 * excludes it from precedence.
 */
export function parseSemver(text: string | null): Semver | null {
  if (text === null) return null;
  let core = text.trim();
  if (core === '') return null;
  if (core.startsWith('v') || core.startsWith('V')) core = core.slice(1);

  const plus = core.indexOf('+');
  if (plus >= 0) core = core.slice(0, plus);

  let pre: string[] = [];
  const dash = core.indexOf('-');
  if (dash >= 0) {
    const tail = core.slice(dash + 1);
    core = core.slice(0, dash);
    if (tail === '') return null;
    pre = tail.split('.');
    if (pre.some((part) => part === '')) return null;
  }

  const parts = core.split('.');
  if (parts.length === 0 || parts.length > 3) return null;
  const numbers: number[] = [];
  for (const part of parts) {
    const parsed = numericIdentifier(part);
    if (parsed === null) return null;
    numbers.push(parsed);
  }
  while (numbers.length < 3) numbers.push(0);
  return { major: numbers[0]!, minor: numbers[1]!, patch: numbers[2]!, pre };
}

/**
 * Semver 2.0.0 precedence. A version WITH a pre-release ranks below the same version without one,
 * so `1.0.0-rc.1 < 1.0.0` — getting that backwards would ship a release candidate to everyone
 * waiting for the release.
 */
export function compareSemver(left: Semver, right: Semver): number {
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;

  const shared = Math.min(left.pre.length, right.pre.length);
  for (let i = 0; i < shared; i++) {
    const a = numericIdentifier(left.pre[i]!);
    const b = numericIdentifier(right.pre[i]!);
    if (a !== null && b !== null) {
      if (a !== b) return a < b ? -1 : 1;
    } else if (a !== null) {
      return -1;
    } else if (b !== null) {
      return 1;
    } else if (left.pre[i] !== right.pre[i]) {
      return left.pre[i]! < right.pre[i]! ? -1 : 1;
    }
  }
  if (left.pre.length !== right.pre.length) return left.pre.length < right.pre.length ? -1 : 1;
  return 0;
}

// ---------------------------------------------------------------------------------------------
// Regex
// ---------------------------------------------------------------------------------------------

export const MAX_PATTERN_LENGTH = 512;
export const MAX_INPUT_LENGTH = 4096;

/** Lookaround and backreferences: where JS, Java and RE2 diverge from one another. */
const UNSUPPORTED = /\(\?[=!]|\(\?<[=!]|\\[1-9]/;

/**
 * Whether a pattern is inside the portable subset the spec defines.
 *
 * Exported and deliberately simple, because the server implements the identical check and a rule
 * that needs a comment to port is one the two will eventually disagree about.
 */
export function isSupportedPattern(pattern: string): boolean {
  if (pattern === '' || pattern.length > MAX_PATTERN_LENGTH) return false;
  return !UNSUPPORTED.test(pattern);
}

/** Unanchored, matching `RegExp.test`. An author wanting the whole string writes `^...$`. */
export function regexMatches(text: string | null, pattern: string): boolean {
  if (text === null || text.length > MAX_INPUT_LENGTH || !isSupportedPattern(pattern)) {
    return false;
  }
  try {
    return new RegExp(pattern).test(text);
  } catch {
    // An invalid pattern is an authoring mistake, not a request failure.
    return false;
  }
}

// ---------------------------------------------------------------------------------------------

/** One element against one clause value. */
export function matchesOne(op: ClauseOp, attribute: AttributeValue, value: string): boolean {
  const text = asText(attribute);
  switch (op) {
    case 'EQUALS':
    case 'IN':
      return text !== null && text === value;
    case 'CONTAINS':
      return text !== null && text.includes(value);
    case 'STARTS_WITH':
      return text !== null && text.startsWith(value);
    case 'ENDS_WITH':
      return text !== null && text.endsWith(value);
    case 'MATCHES':
      return regexMatches(text, value);

    case 'GREATER_THAN':
    case 'GREATER_THAN_OR_EQUAL':
    case 'LESS_THAN':
    case 'LESS_THAN_OR_EQUAL': {
      const left = asNumber(attribute);
      const right = asNumber(value);
      if (left === null || right === null) return false;
      if (op === 'GREATER_THAN') return left > right;
      if (op === 'GREATER_THAN_OR_EQUAL') return left >= right;
      if (op === 'LESS_THAN') return left < right;
      return left <= right;
    }

    case 'BEFORE':
    case 'AFTER': {
      const left = asInstant(attribute);
      const right = asInstant(value);
      if (left === null || right === null) return false;
      return op === 'BEFORE' ? left < right : left > right;
    }

    case 'SEMVER_EQUAL':
    case 'SEMVER_GREATER_THAN':
    case 'SEMVER_LESS_THAN': {
      const left = parseSemver(asText(attribute));
      const right = parseSemver(value);
      if (left === null || right === null) return false;
      const comparison = compareSemver(left, right);
      if (op === 'SEMVER_EQUAL') return comparison === 0;
      if (op === 'SEMVER_GREATER_THAN') return comparison > 0;
      return comparison < 0;
    }

    default:
      // The segment operators are handled by the caller, which has the segment map.
      return false;
  }
}
