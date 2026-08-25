# Targeting

What you can target on, and the two limits worth knowing before you design around them.

Normative semantics live in [`spec/evaluation.md`](../spec/evaluation.md); this page is the
practical version.

---

## Context drives everything

Targeting reads the context your application supplies, so anything you know about a request can
drive a decision:

```js
{ context: { key: userId, attributes: { tenantId: "acme", plan: "pro", platform: "ios" } } }
```

**Turning a feature on for exactly one customer** is a single rule — `tenantId EQUALS acme` serves
`true`, everyone else falls through to `false`.

Reusable cohorts work the same way: put tenant ids in a segment and target `SEGMENT_MATCH`, so one
pilot-customer list drives many flags. All of it is versioned, audited, and revocable per customer by
kill switch.

## Operators

**Text** — `EQUALS`, `IN`, `CONTAINS`, `STARTS_WITH`, `ENDS_WITH`, `MATCHES`
**Numeric** — `GREATER_THAN`, `GREATER_THAN_OR_EQUAL`, `LESS_THAN`, `LESS_THAN_OR_EQUAL`
**Time** — `BEFORE`, `AFTER`
**Versions** — `SEMVER_EQUAL`, `SEMVER_GREATER_THAN`, `SEMVER_LESS_THAN`
**Segments** — `SEGMENT_MATCH`

Any clause can set **negate**, which inverts it. That replaced `NOT_SEGMENT_MATCH`, which is still
accepted and still evaluates identically but is no longer offered in the editor.

The reserved attribute `key` reads the context key itself; everything else reads the attributes map.
An unknown segment key never matches and is never an error.

**Attributes are typed; clause values are always text.** The operator decides how to read both
sides, so `appVersion SEMVER_GREATER_THAN 4.1.9` works whether the attribute arrives as a string or
a number. Arrays match existentially: with `roles = ["admin","billing"]`, `roles EQUALS admin`
matches.

Two behaviours worth knowing before you rely on them:

- **A negated clause on a missing attribute is TRUE.** "plan is not free" holds for somebody with no
  plan attribute at all. It matches LaunchDarkly and it is what the phrase means in English, but it
  catches people out.
- **`MATCHES` is a restricted regex** — unanchored, no lookaround, no backreferences, 512-character
  cap. Both to stop a pathological pattern from stalling evaluation and so that Java and JavaScript
  cannot disagree about what a pattern means.

## One limit, stated plainly

**Bucketing keys off `context.key`.** A percentage rollout splits by whatever you pass as the key —
usually the user. "Roll out to 10% of *customers*" needs a `bucketBy` attribute, which is on the
backlog; today you would pass the tenant id as the context key and give up per-user targeting on
that flag.

~~**Attributes are strings.**~~ Fixed — attributes are typed and the operator set is complete, so
`appVersion SEMVER_GREATER_THAN 4.1.9` on iOS is one rule.

The bucketing limit is tracked in [REMAINING-WORK.md](REMAINING-WORK.md). It is not a bug; it is
scope.
