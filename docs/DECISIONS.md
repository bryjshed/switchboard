# Decisions

Choices that look wrong, arbitrary, or fixable until you know why. Recorded so the next
person changes them **deliberately** rather than "correcting" them and reintroducing the
problem they solved.

If you disagree with one, that is fine — change it and update the entry. What should not
happen is changing one without knowing it was a decision.

---

## Product scope

**The mobile companion in `app/` is not maintained, as of 2026-08-24.** The web dashboard is the
primary management surface and the app was always secondary. Three things decided it: no competitor
ships a first-party mobile management app, so it was never load-bearing for a buyer; every feature
added to the product cost a second implementation while it lived; and its e2e suite cannot run here
anyway, because another project's Metro owns :8081.

What this means concretely — the code stays in the tree and in history, it is **excluded from CI and
from the definition of done**, and it is not updated when a contract changes. It will therefore drift,
and that is expected rather than a bug to report. Reversing this is a catch-up pass against whatever
contract changes have landed since, not a rebuild.

The item it closes out is "mobile app: keep or drop?" in
[REMAINING-WORK.md](REMAINING-WORK.md) §1. It also moots "the mobile app still hardcodes Firebase" in
§2 — true, and now irrelevant.

---

## Evaluation

**Bucketing uses MD5, not SHA-256.** Chosen for ubiquity, not security. Bucketing is not a
security boundary; it is a number that every SDK in every language must compute
*identically*, and MD5 is in every standard library. The predecessor was Java's
`String.hashCode`, which no other language reproduces idiomatically — and whose weak
avalanche put sequential keys in adjacent buckets, so six consecutive `agent-run-N` ids all
landed on one side of a 50/50 split. Aggregate distribution was fine; the defect was *local*
correlation, which is what ruins small samples. Changing the hash reshuffles every existing
assignment.

**The bucket space is 10,000, not 100.** Whole-percent weights are multiplied by 100, so
today's behaviour is identical — but finer-grained rollouts later become a config change
rather than a breaking one. For contrast, flagd cannot express a 0.1% canary today because
its fractional operator is capped at 100 buckets.

**An unknown flag returns the caller's default at HTTP 200.** Not a 404, not a 500. A flag
system that can take an application down when it does not recognise a key is worse than no
flag system. OFREP is the deliberate exception: its spec mandates 404 `FLAG_NOT_FOUND`, so
the OFREP endpoints follow the spec and the native API keeps the fail-safe.

**Rollback writes a new version rather than rewinding.** History is append-only, so "what
was live at 3pm" always has an answer and a rollback is itself rollback-able.

**Evaluation behaviour changes require a spec edit and regenerated vectors in the same
commit.** The vectors are executed by both the Java server and the TypeScript SDK; that
shared execution is the only thing preventing a flag evaluating one way on the server and
another in a client.

---

## Rollout monitoring

**Rates are proportions of distinct subjects, never ratios of event counts.** A server SDK
evaluating a flag in a hot loop emits hundreds of events for one user, so dividing metric
events by evaluation events understates the variance by roughly the average
evaluations-per-subject and inflates any test statistic by roughly its square root. The event
counts are still aggregated and still shown — they are the right number for a volume chart and
the wrong one for a decision. This was the larger of the two defects fixed in the
anytime-valid rewrite, and no amount of statistical sophistication would have covered for it.

**The decision statistic is a mixture SPRT reported as an e-value, not a z-test.** The monitor
runs on a schedule, so whatever it computes is evaluated again and again; a fixed-horizon
statistic is calibrated for one look, and re-running it hourly inflates the false-positive rate
without bound. The e-value is a supermartingale under the null, so Ville's inequality bounds
the probability it *ever* crosses 1/alpha by alpha. The observable consequence — and the
acceptance test for the whole change — is that **the scan interval no longer appears in any
decision**. `TwoProportionZ` survives as a descriptive effect size only; do not restore it as a
decision rule.

**The mixture scale tau is configuration, never fitted to the data.** Validity does not depend
on it; only power does. Deriving tau from the observed effect makes the constant a function of
the sample, destroys the supermartingale property, and leaves every number on the screen
looking exactly as respectable as before.

**Evidence accumulates from the allocation epoch, not over a rolling window.** A rolling window
is not a filtration — observations leave it — so the argument that makes repeated looks safe
does not apply to one. A weight change also changes which populations the arms contain, so
evidence gathered across that boundary tests a null that stopped existing. Restarting on a
weight change is therefore correct rather than unfortunate.

**The baseline is picked from configuration, and on an even split from the off variation.**
Choosing it by observed traffic makes the control a function of the same noise being tested.
Breaking the even-split tie on variation id looks harmless and is not: ids are random UUIDs, so
half the time the degraded arm becomes the baseline, the one-sided test asks whether the
healthy arm is worse than the broken one, and a real regression goes unreported
non-deterministically. Caught by a flaky test during the rewrite, which is the only reason it
was caught.

**A sample-ratio mismatch suppresses the flag's comparisons rather than annotating them.** If
traffic did not arrive in the configured proportions the randomizer is broken, the arms are not
comparable populations, and every rate difference between them is confounded. There is nothing
safe to automate about that, so it raises a finding for a human and carries no proposal. Only
rollout-served traffic counts toward the check — including rule-served or individually-targeted
traffic would trip it the moment anyone adds a targeting rule.

**The multiplicity family is the environment, per direction, and the correction is e-BH.**
Per-flag families give no protection once there are many flags, and the operator's real
question is "how many bogus rollbacks landed in production this hour". Org-wide would let one
noisy team suppress another's true findings. e-BH rather than ordinary BH because these
hypotheses are dependent in a way that cannot be argued away — across flags they share
`metric_events` rows, since a metric event carries no flag key — and e-BH holds under arbitrary
dependence with no penalty factor, where Benjamini-Yekutieli would cost a `ln K` factor.

**The two alphas are asymmetric.** A false rollback reverts to a known-good baseline, is
audited, and is cheap to undo; a false ramp pushes a worse variant onto more traffic and locks
in the next rung. `alpha.heal = 0.05`, `alpha.optimize = 0.01`.

**FDR control is per scan, not across all time.** Per-hypothesis type-I error is controlled
over all time by Ville. There is no construction giving always-valid FDR across unboundedly
many scans, and implying otherwise would be false.

---

## Governance

**The kill switch bypasses approval by default.** Putting an emergency stop behind a review
queue turns an incident into an outage. Configurable per environment
(`requireApprovalForKill`), off by default. This is what LaunchDarkly does, for the same
reason.

**Automated healing also bypasses approval by default.** A rollback that waits for a human
during an error spike is not healing. It is configurable (`allowAutomationBypass`), and the
action is inherently conservative — it reverts to a known-good baseline — and fully audited.

**A gated write returns 202, not 200.** 200 means a new config version exists; 202 means
nothing was written and something is waiting for review. Clients must be able to tell those
apart, and the dashboard models it as a discriminated union so the type checker forces every
call site to handle the queued branch.

**Permissions are a union across org, project and environment — never most-specific-wins.**
Under most-specific-wins, granting someone APPROVER on production would silently *remove*
the flag-write they already held org-wide. A narrow grant should add capability, not strip
it. The cost, accepted knowingly: permissions cannot be subtracted at a narrower scope.
Containment runs one way only — an environment grant does not roll up into project-wide
read, or a VIEWER on dev could read production.

**Self-approval is refused with a 403, not silently discounted.** A reviewer told "recorded"
whose approval does not move the counter has no way to tell nothing happened.

**`minApprovals` and `allowSelfApproval` are snapshotted onto each change request.** Retuning
policy mid-flight must not move the bar for something already under review.

**A change request whose base version was overtaken goes STALE.** It is never applied over
the newer config. Same semantics as the `expectedVersion` 409 on direct writes.

**An AI proposal declined or gone stale leaves the proposal DRAFT.** That is the state it can
be re-applied from, so nothing gets stuck.

---

## Identity

**Identity is a row, not a column.** `user_identities` is `(user_id, issuer, subject)`,
many-to-one. One user may hold several identities, which is what makes IdP migration and
account linking possible at all. The predecessor was `users.firebase_uid NOT NULL UNIQUE` —
a vendor name in the domain layer.

**Linking by email requires the token to assert the email is verified.** Otherwise an IdP
that lets users self-assert an address becomes an account-takeover path. The local dev-token
adoption is a deliberate exception and is load-bearing: Firebase emulator tokens carry
`email_verified: false`, so adoption breaks without it.

**Issuer routing reads the unverified `iss` claim only to select a verifier, then discards
it.** The chosen provider validates the signature and the issuer itself, so forging `iss`
buys a different rejection and nothing else.

**No SAML assertion parsing, deliberately.** Enterprise SAML is handled by delegating to an
OIDC-capable IdP — Auth0, Okta and Entra all do SAML and issue OIDC tokens. Supporting OIDC
covers it without a second protocol implementation.

---

## Implementation

**The dashboard does not use React Query.** Pages use `useState` + `useEffect` + async
`load()`. This matches the conventions of the author's other admin dashboard; consistency
across the two was worth more than the library. Do not introduce it for one page.

**Caching goes through Spring's cache abstraction**, Caffeine now and Redis later by
configuration. Redis is deliberately *not* on the near-term list: Caffeine is correct for one
instance and `NOTIFY` already invalidates every instance, so correctness does not require a
shared store. Build the seam, choose the provider when the deployment shape justifies it.
Full design in [REMAINING-WORK.md](REMAINING-WORK.md).

**Change propagation uses Postgres `NOTIFY`, not Redis pub/sub or a broker.** One fewer piece
of infrastructure for a self-hoster to run, and Postgres is already a hard dependency.

**Flag delivery is REST bootstrap + ETag/304 + SSE push. No gRPC, no WebSockets, and
polling is an SDK fallback mode, not the default.** This matches where the industry
converged in 2026: OFREP — the only vendor-neutral delivery protocol — is REST/OpenAPI
(gRPC is an open discussion, open-feature/protocol#72, not a spec); OpenFeature ADR-0008
standardized SSE change-notification, ADR-0009 ETag-keyed persistence, and ADR-0010
removed default timer polling; LaunchDarkly's FDv2 (GA 2026-05) is still SSE. Do not "add
gRPC for performance" or "simplify to polling" — either move would be a departure from the
standard, not a catch-up. The known delivery gaps are payload-shaped, not
transport-shaped: client key kinds with an evaluated bootstrap, and SDK local persistence.
Full evidence in [design-review-2026-08-24.md](design-review-2026-08-24.md).

**Two controllers are hand-written rather than implementing their generated interface**
(`/api/stream` and the OFREP endpoints). A generated method is fixed to one response type,
and these answer one operation with several body schemas, a bodiless 304, or an infinite
stream. The paths and schemas are still declared in the OpenAPI document; only the binding is
manual, and the reason is in each controller's javadoc.

**Segments are project-scoped, not per-environment.** A simplification versus LaunchDarkly.
Revisit if a real user needs different cohort membership per environment.

**Metric attribution joins on context key within the window.** A context is assigned the
variation it saw most in the window, and its metrics count in the hour it was *first*
evaluated. Good enough to detect a regression; not an analytics product. Bucketing metrics
by their own hour put conversions in buckets with no denominator, so every rate read 0.

**`@DirtiesContext` on the integration test base is load-bearing, not hygiene.** A
`DynamicPropertiesContextCustomizer`'s identity is the set of annotated methods — the same
inherited method for every subclass — so without it all test classes share one cached context
and therefore one database, silently defeating fresh-database-per-class.

---

## Known-good states that look like bugs

- **Mobile e2e fails when another project's Metro owns :8081.** The red screen names files
  that exist in both projects. Not a Switchboard bug. See `.maestro/README.md`.
- **`npm run check` in `app/` can pass on a clean clone and fail locally.** `.expo/types` is
  gitignored, so typed-route narrowing only applies after Metro has run once.
- **`dashboard/scripts/auth-check.mjs` fails its OIDC leg unless the backend has a second
  provider configured.** The script prints the exact command. The Firebase leg passing alone
  is expected on a default stack.
- **AI endpoints return `503 AI_UNAVAILABLE` without an `ANTHROPIC_API_KEY`.** Intended, and
  the UI renders it as an explanation rather than an error. Healing, optimizing and the stale
  sweep all work without a key.
