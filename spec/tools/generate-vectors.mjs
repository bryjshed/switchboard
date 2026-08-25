#!/usr/bin/env node
/**
 * Generates the conformance vector files that are mechanical enough to be generated.
 *
 * `spec/README.md` and `CLAUDE.md` have said "regenerated vectors" since the spec was written, and
 * until now no generator existed — every vector was hand-authored, and the TypeScript runner
 * hardcoded the total. That gap is why adding an operator meant editing a literal in two languages
 * and hoping.
 *
 * What is generated here is the combinatorial part: one operator against a matrix of attribute
 * types and values, where writing the cases by hand is tedious and *reviewing* them by hand is
 * worse. What stays hand-authored is everything about precedence, stickiness and bucketing, where
 * each case exists to pin one specific argument and its name is the point.
 *
 * Expected values are computed by an INDEPENDENT implementation below, not by importing the SDK.
 * A generator that asked the implementation what it does would produce vectors that agree with any
 * bug it has — the same reasoning that keeps `verify-bucket.mjs` reimplementing `bucket()` in four
 * lines rather than importing it.
 *
 *   node spec/tools/generate-vectors.mjs           # write
 *   node spec/tools/generate-vectors.mjs --check   # fail if the files are stale (for CI)
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const conformanceDir = join(here, '..', 'conformance');

// Fixed, readable ids so a diff shows behaviour changes rather than churn.
const FLAG_ID = '0d0d0d0d-0000-0000-0000-000000000001';
const OFF_ID = '0d0d0d0d-0000-0000-0000-0000000000ff';
const ON_ID = '0d0d0d0d-0000-0000-0000-00000000000a';
const RULE_ID = '0c0c0c0c-0000-0000-0000-000000000001';

// ---------------------------------------------------------------------------------------------
// An independent implementation of section 3, used only to compute expected values.
// ---------------------------------------------------------------------------------------------

const asText = (value) => {
  if (typeof value === 'string') return value;
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'number') return Number.isInteger(value) ? String(value) : String(value);
  return null;
};

const asNumber = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
};

/**
 * ISO-8601 date-time, strictly.
 *
 * NOT `Date.parse` on arbitrary text. `Date.parse` is implementation-defined outside ISO-8601, and
 * V8 accepts things no other language would: `Date.parse("4.2.0")` is 2000-04-02. That divergence
 * was caught by these very vectors -- the Java server refused "4.2.0" as a non-date while this
 * generator claimed it was one -- which is exactly why the vectors are executed by both
 * implementations rather than trusted.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

const asInstant = (value) => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const text = asText(value);
  if (text === null) return null;
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (ISO_INSTANT.test(trimmed)) {
    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) return parsed;
  }
  // Otherwise the only other accepted form is a number read as epoch milliseconds.
  const asMillis = asNumber(trimmed);
  return asMillis === null ? null : asMillis;
};

function parseSemver(text) {
  if (typeof text !== 'string') return null;
  let core = text.trim();
  if (core === '') return null;
  if (core.startsWith('v') || core.startsWith('V')) core = core.slice(1);
  const plus = core.indexOf('+');
  if (plus >= 0) core = core.slice(0, plus);
  let pre = [];
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
  const numbers = [];
  for (const part of parts) {
    const parsed = numericIdentifier(part);
    if (parsed === null) return null;
    numbers.push(parsed);
  }
  while (numbers.length < 3) numbers.push(0);
  return { major: numbers[0], minor: numbers[1], patch: numbers[2], pre };
}

function numericIdentifier(text) {
  if (!/^[0-9]+$/.test(text)) return null;
  if (text.length > 1 && text.startsWith('0')) return null;
  return Number(text);
}

function compareSemver(left, right) {
  for (const field of ['major', 'minor', 'patch']) {
    if (left[field] !== right[field]) return left[field] < right[field] ? -1 : 1;
  }
  if (left.pre.length === 0 && right.pre.length === 0) return 0;
  if (left.pre.length === 0) return 1;
  if (right.pre.length === 0) return -1;
  const shared = Math.min(left.pre.length, right.pre.length);
  for (let i = 0; i < shared; i++) {
    const a = numericIdentifier(left.pre[i]);
    const b = numericIdentifier(right.pre[i]);
    if (a !== null && b !== null) {
      if (a !== b) return a < b ? -1 : 1;
    } else if (a !== null) return -1;
    else if (b !== null) return 1;
    else if (left.pre[i] !== right.pre[i]) return left.pre[i] < right.pre[i] ? -1 : 1;
  }
  if (left.pre.length !== right.pre.length) return left.pre.length < right.pre.length ? -1 : 1;
  return 0;
}

const UNSUPPORTED_REGEX = /\(\?[=!]|\(\?<[=!]|\\[1-9]/;

function regexMatches(text, pattern) {
  if (text === null || pattern.length > 512 || text.length > 4096) return false;
  if (UNSUPPORTED_REGEX.test(pattern)) return false;
  try {
    return new RegExp(pattern).test(text);
  } catch {
    return false;
  }
}

function matchesOne(op, attribute, value) {
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
      throw new Error(`Generator does not know operator ${op}`);
  }
}

/** Doubly existential, then negated. Mirrors spec 3.1 and 3.3. */
function clauseMatches(op, attribute, values, negate) {
  let matched = false;
  if (attribute !== undefined && attribute !== null) {
    const elements = Array.isArray(attribute) ? attribute : [attribute];
    matched = elements.some((element) => values.some((value) => matchesOne(op, element, value)));
  }
  return negate ? !matched : matched;
}

// ---------------------------------------------------------------------------------------------
// The case matrix
// ---------------------------------------------------------------------------------------------

/** [name, attribute value]. `undefined` means the attribute is absent. */
const ATTRIBUTES = [
  ['string-pro', 'pro'],
  ['string-numeric', '12'],
  ['string-semver', '4.2.0'],
  ['string-date', '2026-06-01T00:00:00Z'],
  ['number-int', 12],
  ['number-fraction', 12.5],
  ['boolean-true', true],
  ['array-roles', ['admin', 'billing']],
  ['absent', undefined],
];

const OPERATOR_CASES = [
  ['EQUALS', ['pro']],
  ['EQUALS', ['12']],
  ['IN', ['pro', 'admin']],
  ['CONTAINS', ['ro']],
  ['STARTS_WITH', ['p']],
  ['ENDS_WITH', ['o']],
  ['MATCHES', ['^p.o$']],
  ['MATCHES', ['(?=x)']],
  ['GREATER_THAN', ['10']],
  ['GREATER_THAN_OR_EQUAL', ['12']],
  ['LESS_THAN', ['13']],
  ['LESS_THAN_OR_EQUAL', ['12']],
  ['BEFORE', ['2026-07-01T00:00:00Z']],
  ['AFTER', ['2026-01-01T00:00:00Z']],
  ['SEMVER_EQUAL', ['4.2.0']],
  ['SEMVER_GREATER_THAN', ['4.1.9']],
  ['SEMVER_LESS_THAN', ['5.0.0']],
];

function buildOperatorMatrix() {
  const cases = [];
  for (const [op, values] of OPERATOR_CASES) {
    for (const [attributeName, attributeValue] of ATTRIBUTES) {
      for (const negate of [false, true]) {
        const expected = clauseMatches(op, attributeValue, values, negate);
        const context = { key: 'u1' };
        if (attributeValue !== undefined) {
          context.attributes = { subject: attributeValue };
        }
        cases.push({
          name: `${op}${negate ? '-negated' : ''} vs ${attributeName} [${values.join(',')}]`,
          flagKey: 'operators',
          context,
          expected: {
            value: expected ? 'on' : 'off',
            reason: expected ? 'RULE_MATCH' : 'DEFAULT',
            ...(expected ? { ruleId: RULE_ID } : {}),
          },
          clause: { attribute: 'subject', op, values, negate },
        });
      }
    }
  }
  return cases;
}

/**
 * One flag per case: the clause under test IS the flag's only rule, so a case's name and its
 * configuration sit next to each other rather than in separate lookup tables.
 */
function buildOperatorFile() {
  const matrix = buildOperatorMatrix();
  return {
    spec: 'spec/evaluation.md#clauses',
    kind: 'evaluation',
    description:
      'Generated by spec/tools/generate-vectors.mjs. Every operator against every attribute type, ' +
      'with and without negation. Do not edit by hand.',
    flags: matrix.map((testCase, index) => ({
      key: `operators-${index}`,
      kind: 'STRING',
      variations: [
        { id: OFF_ID, value: 'off', name: 'Off' },
        { id: ON_ID, value: 'on', name: 'On' },
      ],
      enabled: true,
      killSwitchActive: false,
      targeting: {
        individualTargets: [],
        rules: [{ id: RULE_ID, clauses: [testCase.clause], serve: { variationId: ON_ID } }],
        fallthrough: { variationId: OFF_ID },
        offVariationId: OFF_ID,
        defaultVariationId: OFF_ID,
      },
    })),
    cases: matrix.map((testCase, index) => ({
      name: testCase.name,
      flagKey: `operators-${index}`,
      context: testCase.context,
      expected: testCase.expected,
    })),
  };
}

// ---------------------------------------------------------------------------------------------

const GENERATED = { 'operators.json': buildOperatorFile };

let stale = 0;
const check = process.argv.includes('--check');

for (const [fileName, build] of Object.entries(GENERATED)) {
  const path = join(conformanceDir, fileName);
  const next = `${JSON.stringify(build(), null, 2)}\n`;
  let current = null;
  try {
    current = readFileSync(path, 'utf8');
  } catch {
    current = null;
  }
  if (current === next) {
    console.log(`  unchanged  ${fileName}`);
    continue;
  }
  if (check) {
    stale++;
    console.log(`  STALE      ${fileName} — run node spec/tools/generate-vectors.mjs`);
    continue;
  }
  writeFileSync(path, next);
  const count = build().cases.length;
  console.log(`  wrote      ${fileName} (${count} cases)`);
}

if (check && stale > 0) {
  console.error(`\n${stale} generated vector file(s) are stale.`);
  process.exit(1);
}
