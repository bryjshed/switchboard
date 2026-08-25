# Switchboard Flag Evaluation Specification

Version 1.0. Status: normative.

This document defines exactly how a Switchboard flag is evaluated for one context. Every SDK, in
every language, must produce byte-identical results to this specification. The Java class
`backend/src/main/java/com/switchboard/domain/evaluation/FlagEvaluator.java` is the reference
implementation; `spec/conformance/*.json` are the machine-readable vectors that prove agreement.

Keywords MUST, MUST NOT, SHOULD and MAY are used in the RFC 2119 sense.

---

## 1. Inputs and outputs

### 1.1 Context

```
Context {
  key:        string   // required, non-empty, non-blank
  attributes: map<string, AttributeValue>   // may be empty
}

AttributeValue = string | number | boolean | array<string | number | boolean>
```

The `key` is the stable identifier the rollout buckets on: a user id, an account id, a device id, a
request id. It MUST NOT be empty or whitespace-only; an SDK MUST reject such a context rather than
substitute a value.

Attribute values are typed, because that is what callers actually have: an app version is a string,
a cart total is a number, a trial flag is a boolean. **Clause values, by contrast, are always
strings** - the operator decides how to read both sides. Section 3.1 has the coercion table and 3.2
the operators.

Text comparisons remain case-sensitive and operate on UTF-8 code points. There is no locale-aware
folding anywhere in this spec.

### 1.2 Flag

```
Flag {
  key:        string          // the bucketing salt and the SDK-facing name
  kind:       BOOLEAN | STRING
  variations: [ { id: uuid, value: string, name: string? } ]
}

EnvironmentConfig {           // one per flag per environment
  enabled:          boolean
  killSwitchActive: boolean
  targeting: {
    individualTargets: [ { contextKey: string, variationId: uuid } ]
    rules:             [ Rule ]
    fallthrough:       Serve
    offVariationId:    uuid    // required
    defaultVariationId: uuid   // required
  }
}

Rule  { id: uuid, description: string?, clauses: [ Clause ], serve: Serve }
Serve { variationId: uuid }  XOR  { rollout: [ { variationId: uuid, weight: int } ] }
Clause { attribute: string, op: ClauseOp, values: [ string ] }
```

`Serve` MUST set exactly one of `variationId` or a non-empty `rollout`.

`kind` is metadata for the dashboard and for SDK type coercion. It does NOT change evaluation: a
BOOLEAN flag is a two-variation flag whose values happen to be the strings `"true"` and `"false"`.

### 1.3 Outcome

```
Outcome {
  variationId: uuid
  value:       string   // the matched variation's value, or null if variationId is unknown
  reason:      KILL_SWITCH | FLAG_OFF | TARGET_MATCH | RULE_MATCH | ROLLOUT | DEFAULT | SDK_DEFAULT
  ruleId:      uuid?    // set if and only if reason is RULE_MATCH
}
```

`ruleId` MUST be null for every reason other than `RULE_MATCH`.

If `variationId` names a variation the flag does not define, `value` MUST be null rather than an
error. This is a defensive case for a config that references a deleted variation.

### 1.4 Purity

Evaluation MUST be a pure function of (flag, environment config, context, segments). No clock, no
randomness, no I/O, no memoised state. Evaluating the same inputs twice MUST give the same answer,
in the same process or in a different one, today or next year.

---

## 2. Precedence ladder <a id="precedence"></a>

Evaluate in this order and return at the first step that produces a result. Later steps are not
consulted.

| # | Condition | Serves | Reason |
|---|-----------|--------|--------|
| 1 | `killSwitchActive` is true | `offVariationId` | `KILL_SWITCH` |
| 2 | `enabled` is false | `offVariationId` | `FLAG_OFF` |
| 3 | An individual target's `contextKey` equals `context.key` | that target's `variationId` | `TARGET_MATCH` |
| 4 | A rule matches (section 3) | resolve that rule's `serve` (section 5) | `RULE_MATCH` (with `ruleId`) |
| 5 | `fallthrough` is a rollout | resolve the rollout (section 5) | `ROLLOUT` |
| 6 | `fallthrough` is a fixed variation | that `variationId` | `DEFAULT` |

Notes:

- Steps 1 and 2 both serve `offVariationId`, but they MUST report different reasons. The kill switch
  is an operator override; `enabled: false` is the flag's normal off state. Collapsing them loses
  the distinction the dashboard and the audit log depend on.
- Individual targets are scanned in list order and the first whose `contextKey` equals `context.key`
  wins. Duplicate context keys in the list are a configuration error, not an evaluation error.
- Rules are evaluated in list order. The FIRST rule whose clauses all match wins; remaining rules are
  not evaluated. Rule order is significant and MUST be preserved on the wire.
- `defaultVariationId` is dashboard metadata (the variation offered when a new environment is
  created). It is NEVER consulted during evaluation. Do not confuse it with `fallthrough`.

---

## 3. Rules and clauses <a id="clauses"></a>

A rule matches when ALL of its clauses match (logical AND). A rule with an empty clause list matches
every context; this is the "serve everyone" rule the dashboard writes for a plain rollout.

A clause matches when ANY of its `values` satisfies the operator (logical OR within a clause). A
clause with an empty `values` list therefore NEVER matches.

### 3.1 Reading the attribute

For every operator except `SEGMENT_MATCH`, the clause reads one attribute value:

- if `attribute` is exactly `"key"` (the reserved attribute), read `context.key` as a string;
- otherwise read `context.attributes[attribute]`.

`"key"` is reserved: an entry literally named `key` inside the attributes map is ignored and
unreachable.

**A missing attribute FAILS the clause** (before negation). If the attribute is absent, the clause
is false. It is not an error, it does not skip the clause, and it does not skip the rule. Because a
rule is a conjunction, one missing attribute makes the whole rule fail and evaluation moves to the
next rule.

An attribute explicitly set to `null` is **absent**. So is one whose value is a JSON object: no
operator can act on one, and inventing a coercion would invent matches.

#### Attribute types

An attribute value is a string, a number, a boolean, or an array of those. Nested arrays are
flattened; a nested object is dropped.

**Clause values are always strings**, at every operator. The *operator* decides how both sides are
read - one rule to learn, and a wire format that stays legible in a form, a diff and a JSON blob.

| Attribute is | As text | As number | As instant | As version |
|---|---|---|---|---|
| string `"4.2.0"` | `4.2.0` | - | - | `4.2.0` |
| string `"12"` | `12` | `12` | epoch millis `12` | `12.0.0` |
| number `12` | `12` | `12` | epoch millis `12` | `12.0.0` |
| number `12.5` | `12.5` | `12.5` | epoch millis `12` | - |
| boolean `true` | `true` | - | - | - |
| array | - | - | - | - |

An integral number renders as text **without** a trailing `.0`: the number `4` is the text `"4"`, so
`version EQUALS 4` matches it and `"4.0"` does not.

A string that parses as a number IS accepted by the numeric operators. An attribute arriving from a
query string or a header is text even when it means a number, and refusing it would make those
operators useless exactly where they are most wanted.

#### Arrays match existentially

Every operator is existential twice over: the clause matches when **any** element of an array-valued
attribute relates to **any** listed value. So with `roles = ["admin", "billing"]`,
`roles EQUALS ["owner", "admin"]` matches.

An array has no single text, so it never satisfies a text operator directly - only its elements do.

### 3.2 Operators

**Text.** Case-sensitive, over UTF-8 code points rather than bytes.

| Operator | Matches when |
|----------|--------------|
| `EQUALS` | the attribute's text equals any listed value |
| `IN` | identical to `EQUALS`; the name exists for readability when the list has several values |
| `CONTAINS` | the attribute's text contains any listed value as a substring |
| `STARTS_WITH` | the attribute's text begins with any listed value |
| `ENDS_WITH` | the attribute's text ends with any listed value |
| `MATCHES` | the attribute's text matches any listed value as a regular expression |

**Numeric.** Both sides read as numbers; either side failing to parse makes the clause false.

| Operator | Matches when |
|----------|--------------|
| `GREATER_THAN` | attribute > any listed value |
| `GREATER_THAN_OR_EQUAL` | attribute >= any listed value |
| `LESS_THAN` | attribute < any listed value |
| `LESS_THAN_OR_EQUAL` | attribute <= any listed value |

**Time.** Both sides read as instants: ISO-8601 date-time text or a number read as epoch
milliseconds.

The accepted text form is **strictly** `YYYY-MM-DDTHH:MM:SS[.sss](Z|±HH:MM)`. An implementation MUST
NOT hand arbitrary text to a permissive platform date parser. JavaScript's `Date.parse` is
implementation-defined outside ISO-8601 and V8 reads `"4.2.0"` as 2 April 2000, where a strict
parser rejects it — so the same rule would match in a browser and not on the server. This was found
by the conformance vectors during the operator work, which is what they are for.

| Operator | Matches when |
|----------|--------------|
| `BEFORE` | the attribute is strictly before any listed instant |
| `AFTER` | the attribute is strictly after any listed instant |

**Versions.** Both sides parsed as semver 2.0.0.

| Operator | Matches when |
|----------|--------------|
| `SEMVER_EQUAL` | the attribute equals any listed version in precedence |
| `SEMVER_GREATER_THAN` | the attribute is greater than any listed version |
| `SEMVER_LESS_THAN` | the attribute is less than any listed version |

**Segments.**

| Operator | Matches when |
|----------|--------------|
| `SEGMENT_MATCH` | the context matches any segment named in `values` (section 4) |
| `NOT_SEGMENT_MATCH` | **Deprecated.** Exactly `SEGMENT_MATCH` with `negate` flipped |

For the segment operators the `attribute` field is IGNORED. The wire format still requires it to be
non-empty; the dashboard writes `"key"`. An implementation MUST NOT read the attribute for these.

`NOT_SEGMENT_MATCH` remains accepted so configurations written before per-clause negation existed
keep evaluating identically. An implementation MUST normalise it to `SEGMENT_MATCH` with `negate`
inverted, and MUST NOT emit it.

#### Semver parsing

Lenient about the leading `v` and about missing segments: `4`, `v4.2` and `4.2.0` all parse, and
absent segments are zero. Build metadata (`+sha`) is discarded, because semver 2.0.0 excludes it
from precedence. Pre-release versions rank **below** the same version without one, so
`1.0.0-rc.1 < 1.0.0`; numeric pre-release identifiers compare numerically and rank below
alphanumeric ones. Anything else fails to parse, and its clause is false.

#### The regex subset

`MATCHES` is **unanchored** - it matches anywhere in the text, like JavaScript's `RegExp.test`. An
author wanting the whole string writes `^...$`.

Patterns are restricted to a portable subset, and an implementation MUST reject anything outside it
by failing the clause:

- **No lookaround**: `(?=`, `(?!`, `(?<=`, `(?<!`.
- **No backreferences**: `\1` through `\9`.
- **Pattern at most 512 characters**, and the text being matched at most 4096.

Two reasons, and both matter. A pattern is untrusted input on the hot path, and backtracking engines
take exponential time on patterns like `(a+)+$` - somebody who can edit a flag must not be able to
stop evaluation for everyone. And a rule evaluated in Java on the server and in JavaScript in a
browser must mean the same thing in both; lookaround and backreferences are where those engines
diverge from each other and from RE2.

An unsupported, invalid, or over-long pattern makes the clause **false** in every implementation.
That is the same answer for the same reason everywhere, so conformance holds even for a pattern
nobody will run.

### 3.3 Negation

A clause may set `negate: true`, which **inverts its result**.

Negation is applied last, to the result of the comparison, and it inverts the missing-attribute case
too. **A negated clause on a missing attribute is TRUE.**

That is deliberate and matches LaunchDarkly. "Release to everyone whose plan is not free" should
include somebody with no plan attribute at all - they are, after all, not on the free plan. But it
surprises people often enough to be worth stating twice, so it is also pinned by conformance
vectors.

The segment operators negate the same way: `SEGMENT_MATCH` with `negate` is true when the context
matches none of the named segments, including when a named segment does not exist (an unknown
segment never matches, so its negation does).

Inside a **segment rule**, a nested segment operator fails the clause outright and negation does not
rescue it - see section 4.2. A refusal to follow a configuration must not become a match.

---

## 4. Segments <a id="segments"></a>

```
Segment {
  key:          string
  includedKeys: [ string ]
  excludedKeys: [ string ]
  rules:        [ { clauses: [ Clause ] } ]
}
```

A `SEGMENT_MATCH` clause lists one or more segment keys and matches when ANY of them matches.

**Unknown segment keys FAIL, they never error.** If a listed segment key is not present in the
environment's segment map, that segment simply does not match. An SDK MUST NOT throw, log at error
level, or fall back to a default; a segment can legitimately be missing from a stale snapshot while a
rule that references it is already live.

### 4.1 Matching order inside a segment

Evaluate in this order and stop at the first that applies:

1. `context.key` is in `excludedKeys` &rarr; the segment does NOT match. Exclusion is absolute and
   beats both inclusion and every rule.
2. `context.key` is in `includedKeys` &rarr; the segment MATCHES.
3. Any segment rule whose clauses ALL match &rarr; the segment MATCHES.
4. Otherwise the segment does not match.

A key present in both `includedKeys` and `excludedKeys` is excluded.

### 4.2 Segment rules cannot nest

A segment rule's clauses support attribute operators only. If a segment rule contains a clause whose
operator is `SEGMENT_MATCH` or `NOT_SEGMENT_MATCH`, that clause FAILS, which fails its rule. This
makes segment evaluation non-recursive and unable to cycle. An SDK MUST NOT attempt to resolve nested
segments.

**Negation does not rescue it.** A nested segment clause fails its rule whether or not `negate` is
set: this is a refusal to follow a configuration, not a comparison that came out false, and turning
a refusal into a match would let an unsupported config silently match everybody.

---

## 5. Bucketing <a id="bucketing"></a>

### 5.1 The algorithm

```
BUCKET_SPACE = 10000

bucket(flagKey, contextKey) = int( hex( md5( flagKey + ":" + contextKey ) )[0:8], 16 ) % BUCKET_SPACE
```

Precisely:

1. Concatenate `flagKey`, the single ASCII character `:` (0x3A), and `contextKey`.
2. Encode that string as UTF-8 bytes.
3. Take the MD5 digest (16 bytes).
4. Take the first 4 bytes, read big-endian, as an UNSIGNED 32-bit integer. Equivalently: render the
   digest as lowercase hex and parse characters 0..7 as a base-16 integer.
5. Return that integer modulo `BUCKET_SPACE`.

The result is an integer in `[0, 10000)`.

Implementations in languages with signed 32-bit integers MUST widen to 64 bits (or use an unsigned
type) before the modulo. Reading the 4 bytes into a signed `int32` gives a negative number for half
of all inputs and silently produces wrong buckets.

### 5.2 Why MD5

MD5 is chosen for UBIQUITY, not security. It is in the standard library of every language a
Switchboard SDK could plausibly target: JavaScript (`node:crypto`), Python (`hashlib`), Go
(`crypto/md5`), Java (`MessageDigest`), Ruby (`Digest::MD5`), PHP (`md5()`), Rust (`md-5`), C#
(`MD5`). An SDK author can implement bucketing correctly in four lines with no dependency.

Nothing about this is a security boundary. The function hashes a public flag key together with a
context key the caller chose. A collision or a preimage buys an attacker nothing they could not
already get by picking their own context key, and there is no secret to recover.

**Do not "upgrade" this to SHA-256.** The digest is part of the cross-language wire contract.
Changing it reassigns every context in every in-flight rollout and desynchronises every deployed SDK
until it is upgraded. Such a change requires a new spec version, regenerated conformance vectors, and
a deliberate migration plan.

### 5.3 Worked example

Verify your hash in isolation before you write anything else.

```
flagKey    = "new-checkout"
contextKey = "user-3"

input      = "new-checkout:user-3"
md5(input) = 69be58fb38862cdd5e1b6feb12c3b5cf
[0:8]      = 69be58fb
int        = 1774082299
% 10000    = 2299

bucket("new-checkout", "user-3") == 2299
```

A second example with a wider digest prefix, to catch signed-integer bugs (`0xfb21b11f` overflows a
signed 32-bit int):

```
input      = "new-checkout:agent-run-3"
md5(input) = fb21b11f...
[0:8]      = fb21b11f
int        = 4213289247
% 10000    = 9247
```

`spec/conformance/bucket.json` carries 22 such vectors, including empty flag keys, keys containing
`:`, spaces, accented Latin, CJK and emoji. `spec/tools/verify-bucket.mjs` is a four-line reference
implementation that checks them.

### 5.4 Why 10000 and not 100

Rollout weights on the wire are whole percents summing to 100, so a bucket space of 100 would be
enough today. `BUCKET_SPACE` is 10000 so that one percent of weight covers exactly 100 buckets.

External behaviour at today's 1%-granularity weights is IDENTICAL to a 100-bucket space: the
cumulative walk multiplies each weight by 100, so the boundaries land on exact multiples of 100 and
every context falls on the same side of every boundary either way.

The two extra digits are headroom. Supporting 0.01%-granularity rollouts later becomes a wire-format
change to the weight field alone, not a change to the hash, and therefore does not reshuffle anyone.
Introducing the finer space now, before any SDK ships, costs nothing; introducing it later would be a
second breaking change.

### 5.5 Resolving a rollout

Given `serve.rollout` and a bucket:

```
cumulative = 0
for each weighted in rollout (IN ORDER):
    cumulative += weighted.weight * (BUCKET_SPACE / 100)
    if bucket < cumulative:
        return weighted.variationId
return rollout.last.variationId    # unreachable when weights sum to 100
```

The comparison is strictly less-than against the running cumulative, so a variation with weight `w`
owns exactly `w * 100` buckets.

Rollout order is significant and MUST be preserved on the wire. Two rollouts with the same weights in
a different order assign different contexts.

The bucketing salt is always the FLAG key, never the rule id. A rule serving a rollout and the
fallthrough serving a rollout bucket a given context identically; only the weights differ. This is
deliberate: moving a context between a rule and the fallthrough must not reshuffle it.

### 5.6 Invariants this buys

- **Stickiness.** The same (flagKey, contextKey) always lands in the same bucket, in every process,
  in every language, forever. A context does not flip variation between two page loads.
- **Ramp monotonicity.** Raising the first variation's weight from 10 to 25 (keeping the ordering)
  only ever ADMITS contexts. Everyone served the first variation at 10% is still served it at 25%,
  because the bucket did not move and the boundary only moved up. `spec/conformance/ramp-at-10.json`
  and `ramp-at-25.json` prove this over the same 40 contexts.
- **Decorrelation.** The flag key is part of the hash input, so two flags at 50/50 do not split the
  population the same way. Without the salt, the same unlucky half of users would be the guinea pigs
  for every experiment.
- **Even spread over neighbouring keys.** MD5 avalanches, so `user-1` and `user-2` land in unrelated
  buckets. Over `user-1`..`user-1000` a 50/50 rollout splits 512/488 and a 10/90 splits 119/881.

---

## 6. Rollout weight rules <a id="rollout-weights"></a>

- Each `weight` MUST be an integer in `[0, 100]`.
- The weights of one rollout MUST sum to EXACTLY 100.
- A weight of 0 is legal. That variation is never served, because it owns zero buckets.
- A rollout MUST have at least one entry. An empty list is not a rollout; use a fixed `variationId`.

These rules are enforced at CONFIGURATION time. An evaluator MUST NOT normalise, rescale or repair
weights at evaluation time: silently rescaling a 50/40 rollout to 55/45 would move contexts between
variations with no audit trail. A stored config that violates these rules is a bug in whatever wrote
it, and the SDK SHOULD treat the flag as unreadable and fall back per section 7.

`spec/conformance/rollout-weights.json` enumerates the accepted and rejected shapes.

---

## 7. The fail-safe rule

**An evaluation request for an unknown flag MUST serve the caller's own default and report reason
`SDK_DEFAULT`. It MUST NOT raise, and the HTTP surface MUST NOT return an error status.**

This covers a flag that has been deleted, a flag that does not exist in this environment, a typo in
the caller's flag key, and a snapshot that is older than the flag. If the caller supplied no default,
serve the empty string.

The wider principle: a feature flag system is on the critical path of everything that reads it. A
flag system that throws is worse than a flag system that is briefly wrong. An SDK SHOULD extend the
same posture to a malformed config or an unreachable server: serve the caller's default, report
`SDK_DEFAULT`, and surface the problem through logs and metrics rather than through an exception in
the caller's request path.

---

## 8. Conformance

An implementation conforms when it passes every vector in `spec/conformance/`. See
`spec/README.md` for how to run them and for the rule that binds a behaviour change to a spec change.
