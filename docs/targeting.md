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

Six today: `EQUALS`, `IN`, `CONTAINS`, `STARTS_WITH`, `SEGMENT_MATCH`, `NOT_SEGMENT_MATCH`.

The reserved attribute `key` reads the context key itself; everything else reads the attributes map.
An unknown segment key never matches and is never an error.

## Two limits, stated plainly

**Bucketing keys off `context.key`.** A percentage rollout splits by whatever you pass as the key —
usually the user. "Roll out to 10% of *customers*" needs a `bucketBy` attribute, which is on the
backlog; today you would pass the tenant id as the context key and give up per-user targeting on
that flag.

**Attributes are strings, compared by those six operators.** So `version >= 4.2.0` is not
expressible, and neither is a date comparison or a regex. Typed attributes and the full operator set
are on the backlog.

Both are tracked in [REMAINING-WORK.md](REMAINING-WORK.md). Neither is a bug; both are scope.
