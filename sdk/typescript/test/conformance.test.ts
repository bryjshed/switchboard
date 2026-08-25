/**
 * Executes every vector in `spec/conformance/*.json` against this SDK's evaluator.
 *
 * These are the SAME files the Java reference implementation runs in
 * `backend/src/test/java/com/switchboard/domain/evaluation/ConformanceVectorTest.java`. Passing
 * all of them is the definition of conformance (spec/README.md). Nothing here may be loosened:
 * if a vector fails, the port is wrong, not the vector.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BUCKET_SPACE, bucket, evaluate, validateRolloutWeights } from '../src/evaluation/index.js';
import type { EvalContext, Flag, Segment } from '../src/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const conformanceDir = join(here, '..', '..', '..', 'spec', 'conformance');

const files = readdirSync(conformanceDir)
  .filter((name) => name.endsWith('.json'))
  .sort();

type AnyDoc = Record<string, any>;

function load(name: string): AnyDoc {
  return JSON.parse(readFileSync(join(conformanceDir, name), 'utf8')) as AnyDoc;
}

/**
 * Vector files spell the per-environment config `targeting`; the wire (and therefore this SDK)
 * spells it `config`. A pure field rename, no behaviour attached.
 */
function toFlag(vectorFlag: AnyDoc): Flag {
  return { ...vectorFlag, config: vectorFlag['targeting'] ?? vectorFlag['config'] } as Flag;
}

function indexFlags(doc: AnyDoc): Map<string, Flag> {
  const flags = new Map<string, Flag>();
  for (const raw of (doc['flags'] ?? []) as AnyDoc[]) {
    const flag = toFlag(raw);
    flags.set(flag.key, flag);
  }
  return flags;
}

function indexSegments(doc: AnyDoc): Map<string, Segment> {
  const segments = new Map<string, Segment>();
  for (const segment of (doc['segments'] ?? []) as Segment[]) {
    segments.set(segment.key, segment);
  }
  return segments;
}

let executed = 0;

describe('conformance vectors', () => {
  it('finds the shared vector directory', () => {
    expect(files.length).toBeGreaterThan(0);
  });

  for (const file of files) {
    const doc = load(file);

    if (doc['kind'] === 'bucket') {
      describe(`${file} (bucket)`, () => {
        expect(doc['bucketSpace']).toBe(BUCKET_SPACE);
        for (const vector of doc['bucketVectors'] as AnyDoc[]) {
          it(`bucket(${JSON.stringify(vector['input'])}) === ${vector['bucket']}`, () => {
            executed += 1;
            expect(bucket(vector['flagKey'], vector['contextKey'])).toBe(vector['bucket']);
          });
        }
      });
      continue;
    }

    if (doc['kind'] === 'evaluation') {
      const flags = indexFlags(doc);
      const segments = indexSegments(doc);
      describe(`${file} (evaluation)`, () => {
        for (const testCase of doc['cases'] as AnyDoc[]) {
          it(testCase['name'], () => {
            executed += 1;
            const context = testCase['context'] as EvalContext;
            const outcome = evaluate(
              flags.get(testCase['flagKey']),
              context,
              segments,
              testCase['default'] ?? '',
            );
            expect(outcome.value).toBe(testCase['expected']['value']);
            expect(outcome.reason).toBe(testCase['expected']['reason']);
            // ruleId is set if and only if the reason is RULE_MATCH (spec/evaluation.md 1.3).
            expect(outcome.ruleId).toBe(testCase['expected']['ruleId'] ?? null);
          });
        }
      });
      continue;
    }

    if (doc['kind'] === 'rollout-validation') {
      describe(`${file} (rollout-validation)`, () => {
        for (const vector of doc['rolloutValidation'] as AnyDoc[]) {
          it(vector['name'], () => {
            executed += 1;
            const result = validateRolloutWeights(vector['weights'] as number[]);
            expect(result.valid).toBe(vector['valid']);
            if (vector['valid'] === false) {
              expect(result.reason).toBe(vector['reason']);
            }
          });
        }
      });
      continue;
    }

    throw new Error(`unhandled conformance vector kind: ${String(doc['kind'])} in ${file}`);
  }
});

/**
 * The one cross-file assertion (spec/README.md): raising a ramp only ever ADMITS contexts. Every
 * context served the true variation at 10% must still be served it at 25%, because the bucket did
 * not move and only the boundary did.
 */
describe('ramp monotonicity across files', () => {
  const rampFiles = files.filter((name) => load(name)['rampGroup'] !== undefined);

  it('has two ramp files sharing one flag key', () => {
    expect(rampFiles.length).toBe(2);
    const keys = new Set(rampFiles.map((name) => load(name)['rampGroup']['flagKey']));
    expect(keys.size).toBe(1);
  });

  it('every context served true at the lower percent is still served true at the higher one', () => {
    const docs = rampFiles
      .map((name) => load(name))
      .sort((a, b) => a['rampGroup']['percent'] - b['rampGroup']['percent']);
    const [lower, higher] = docs as [AnyDoc, AnyDoc];
    const trueValue = lower['rampGroup']['trueVariationValue'];

    const served = (doc: AnyDoc): Set<string> => {
      const flags = indexFlags(doc);
      const segments = indexSegments(doc);
      const admitted = new Set<string>();
      for (const testCase of doc['cases'] as AnyDoc[]) {
        const outcome = evaluate(flags.get(testCase['flagKey']), testCase['context'], segments);
        if (outcome.value === trueValue) {
          admitted.add(testCase['context']['key']);
        }
      }
      return admitted;
    };

    const atLower = served(lower);
    const atHigher = served(higher);
    expect(atLower.size).toBeGreaterThan(0);
    for (const key of atLower) {
      expect(atHigher.has(key), `${key} was admitted at the lower ramp but not the higher one`).toBe(
        true,
      );
    }
  });
});

describe('vector coverage', () => {
  it('runs every vector in spec/conformance', () => {
    // This used to be `toBe(201)` — a literal that had to be hand-edited in two languages every
    // time a vector was added, which is exactly the friction that kept anyone from adding any.
    // Counting the files instead means a vector that exists but is never executed — a whole file
    // silently skipped by a parsing bug, say — still fails here, without pinning a number.
    let expected = 0;
    for (const name of files) {
      const vectors = load(name);
      if (vectors['kind'] === 'bucket') {
        expected += (vectors['bucketVectors'] as unknown[]).length;
      } else if (vectors['kind'] === 'evaluation') {
        expected += (vectors['cases'] as unknown[]).length;
      } else if (vectors['kind'] === 'rollout-validation') {
        expected += (vectors['rolloutValidation'] as unknown[]).length;
      }
    }
    expect(expected).toBeGreaterThan(500);
    expect(executed).toBe(expected);
  });
});
