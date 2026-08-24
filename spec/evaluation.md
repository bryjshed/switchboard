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
  attributes: map<string, string>   // may be empty
}
```

The `key` is the stable identifier the rollout buckets on: a user id, an account id, a device id, a
request id. It MUST NOT be empty or whitespace-only; an SDK MUST reject such a context rather than
substitute a value.

Attribute values are strings. All comparisons in this spec are byte-for-byte on the UTF-8 string,
and are case-sensitive. There is no type coercion, no numeric comparison and no locale-aware
folding.

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

For every operator except `SEGMENT_MATCH` and `NOT_SEGMENT_MATCH`, the clause reads one string:

- if `attribute` is exactly `"key"` (the reserved attribute), read `context.key`;
- otherwise read `context.attributes[attribute]`.

`"key"` is reserved: an entry literally named `key` inside the attributes map is ignored and
unreachable.

**A missing attribute FAILS the clause.** If the attribute is absent from the map, the clause is
false. It is not an error, it does not skip the clause, and it does not skip the rule. Because a rule
is a conjunction, one missing attribute makes the whole rule fail and evaluation moves to the next
rule.

### 3.2 Operators

| Operator | Matches when |
|----------|--------------|
| `EQUALS` | the attribute is byte-for-byte equal to any listed value |
| `IN` | identical to `EQUALS`; the name exists for readability when the list has several values |
| `CONTAINS` | the attribute contains any listed value as a substring |
| `STARTS_WITH` | the attribute begins with any listed value |
| `SEGMENT_MATCH` | the context matches any segment named in `values` (section 4) |
| `NOT_SEGMENT_MATCH` | the context matches NONE of the segments named in `values` |

`EQUALS` and `IN` are exact and case-sensitive: `"PRO"` does not match `"pro"`, and `"pro-plus"` does
not match `"pro"`.

`CONTAINS` and `STARTS_WITH` operate on UTF-8 code points, not bytes; splitting a multi-byte
character is not possible because both operands are strings, not byte arrays.

For `SEGMENT_MATCH` and `NOT_SEGMENT_MATCH` the `attribute` field is IGNORED. The wire format still
requires it to be non-empty; the dashboard writes `"key"`. An implementation MUST NOT read the
attribute for these operators.

`NOT_SEGMENT_MATCH` is the exact logical negation of `SEGMENT_MATCH` over the same segment list,
including the failure modes: an unknown segment key does not match, so `NOT_SEGMENT_MATCH` on an
unknown segment key MATCHES.

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
