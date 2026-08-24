# Switchboard evaluation spec

This directory is the single source of truth for how a Switchboard flag is evaluated. It exists so
that an SDK written in TypeScript, Go, Python, Ruby, Rust or anything else computes byte-identical
results to the server, including which contexts land in which half of a percentage rollout.

```
spec/
  evaluation.md            the normative prose spec
  conformance/*.json       machine-readable test vectors (201 of them)
  tools/verify-bucket.mjs  a four-line reference bucket() in JS, checked against the vectors
```

The Java class `backend/src/main/java/com/switchboard/domain/evaluation/FlagEvaluator.java` is the
REFERENCE IMPLEMENTATION. The spec describes what it does; the vectors prove it. The JUnit test
`backend/src/test/java/com/switchboard/domain/evaluation/ConformanceVectorTest.java` loads every file
in `conformance/` and asserts the reference implementation matches, which is what keeps the vectors
authoritative rather than aspirational.

---

## Writing an SDK

**Step 1: get `bucket()` right, before anything else.** Every rollout answer depends on it, and it is
the one part of the algorithm that is easy to get subtly wrong (signed 32-bit overflow, hashing UTF-16
instead of UTF-8, taking the last 4 bytes instead of the first). Read
[`evaluation.md` section 5](evaluation.md#bucketing), implement the formula, and run your
implementation against `conformance/bucket.json`. It carries 22 vectors with the intermediate hex and
integer for each, so a mismatch tells you which step is wrong rather than just that the answer is
wrong. `tools/verify-bucket.mjs` is a worked example of this check:

```
node spec/tools/verify-bucket.mjs --print
```

**Step 2: implement the precedence ladder and the clause operators** from `evaluation.md` sections
2 to 4, then run the `evaluation` vector files. They are ordered roughly by how much they depend on:
`precedence-boolean` and `precedence-multivariate` need no hashing beyond the rollout cases,
`clauses` and `segments` need none at all, and `stickiness` / `ramp-at-*` are pure bucketing.

**Step 3: implement the fail-safe** (`evaluation.md` section 7) and the weight validation
(section 6). An unknown flag serves the caller's default with reason `SDK_DEFAULT` and never raises.

---

## Vector files

| File | Kind | Vectors | Covers |
|------|------|--------:|--------|
| `bucket.json` | `bucket` | 22 | the pure hash, with md5/prefix/int intermediates; empty flag key, `:` inside a key, spaces, accented Latin, CJK, emoji, UUID context keys |
| `precedence-boolean.json` | `evaluation` | 18 | every rung of the ladder on a two-variation flag: kill switch, disabled, individual target, rule, first-match-wins, fixed fallthrough, rollout fallthrough, a rule serving a rollout, a zero-weight variation, and the unknown-flag fail-safe |
| `precedence-multivariate.json` | `evaluation` | 13 | the same ladder on a three-variation string flag, plus an uneven 34/33/33 rollout |
| `clauses.json` | `evaluation` | 21 | `EQUALS`, `IN`, `CONTAINS`, `STARTS_WITH` positive and negative; case sensitivity; the reserved `key` attribute; a missing attribute; an empty values list; an empty clause list; conjunction across clauses |
| `segments.json` | `evaluation` | 12 | `SEGMENT_MATCH` and `NOT_SEGMENT_MATCH`; excluded before included before rules; any-of over several segments; an unknown segment key; a segment rule that illegally nests a segment operator |
| `stickiness.json` | `evaluation` | 24 | the same evaluation repeated three times must not move, and two flags with identical weights must not agree on every context |
| `ramp-at-10.json` | `evaluation` | 40 | one flag key at a 10% ramp over 40 contexts |
| `ramp-at-25.json` | `evaluation` | 40 | the SAME flag key and contexts at 25%; every context served at 10% must still be served at 25% |
| `rollout-weights.json` | `rollout-validation` | 11 | which weight lists are accepted and which are rejected |

201 vectors total, plus one cross-file assertion (ramp monotonicity, which spans the two `ramp-at-*`
files by design because bucketing salts on the flag key and both files must therefore share it).

## Vector file schema

Every file has `kind`, a human-readable `description`, and a `spec` pointer to the section of
`evaluation.md` it exercises.

`kind: "bucket"` files carry `bucketVectors`:

```jsonc
{
  "kind": "bucket",
  "bucketSpace": 10000,
  "bucketVectors": [
    {
      "flagKey": "new-checkout",
      "contextKey": "user-3",
      "input": "new-checkout:user-3",       // flagKey + ":" + contextKey
      "md5Hex": "69be58fb38862cdd5e...",    // the full digest, lowercase hex
      "prefixHex": "69be58fb",              // characters 0..7
      "prefixInt": 1774082299,              // prefixHex as an unsigned 32-bit int
      "bucket": 2299                        // prefixInt % bucketSpace
    }
  ]
}
```

`kind: "evaluation"` files carry a self-contained environment plus cases against it:

```jsonc
{
  "kind": "evaluation",
  "flags": [ { "key", "kind", "variations": [{ "id", "value", "name" }],
               "enabled", "killSwitchActive",
               "targeting": { "individualTargets", "rules", "fallthrough",
                              "offVariationId", "defaultVariationId" } } ],
  "segments": [ { "key", "name", "includedKeys", "excludedKeys", "rules" } ],
  "cases": [
    {
      "name": "human-readable, used as the test name",
      "flagKey": "checkout-targeted",       // matches flags[].key; absent on purpose for SDK_DEFAULT
      "context": { "key": "user-1", "attributes": { "plan": "pro" } },
      "default": "fallback-x",              // optional; only meaningful for the unknown-flag case
      "expected": { "value": "false", "reason": "TARGET_MATCH", "ruleId": null }
    }
  ]
}
```

Flag keys are unique within a file. A case whose `flagKey` is not in `flags` is an unknown-flag case
and MUST resolve to the caller's `default` (or `""`) with reason `SDK_DEFAULT`. `expected.ruleId` is
present only when the reason is `RULE_MATCH`.

Variation and rule ids are fixed, readable UUIDs (`0a0a0a0a-...` for boolean variations,
`0b0b0b0b-...` for the multivariate flag, `0c0c0c0c-...` for rules) so a diff of a regenerated vector
file shows behaviour changes rather than churn.

`kind: "rollout-validation"` files carry `rolloutValidation`: a list of `{ name, weights, valid }`,
with a `reason` (`SUM_NOT_100` or `WEIGHT_OUT_OF_RANGE`) on the invalid entries.

Files with `rampGroup` (`{ flagKey, trueVariationValue, percent }`) participate in the cross-file
monotonicity assertion.

---

## The rule

**Any change to evaluation behaviour lands as a spec change plus regenerated vectors in the SAME
commit as the code change.**

Not a follow-up PR, not a TODO. The moment `FlagEvaluator` and `spec/` disagree, every SDK author is
working from a document that lies, and the vectors stop being evidence of anything. Concretely:

1. Change `FlagEvaluator`.
2. Update the affected section of `evaluation.md`.
3. Update or add the vectors in `conformance/` that pin the new behaviour, including negative cases.
4. `./mvnw test -Dtest=ConformanceVectorTest` must pass without any assertion being loosened.
5. Keep `FlagEvaluatorTest` too. The vectors prove conformance; the hand-written tests document
   intent in a form a reviewer can read.

Changing the bucketing algorithm itself (the digest, the byte prefix, the separator, `BUCKET_SPACE`)
is a breaking change of a different order: it reassigns every context in every in-flight rollout and
desynchronises every deployed SDK until it is upgraded. That needs a spec version bump and a
migration plan, not a drive-by edit.
