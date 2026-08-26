# Decisions

Choices that look wrong, arbitrary, or fixable until you know why. Recorded so the next
person changes them **deliberately** rather than "correcting" them and reintroducing the
problem they solved.

If you disagree with one, that is fine — change it and update the entry. What should not
happen is changing one without knowing it was a decision.

---

## Product scope

**The Expo mobile companion was deleted on 2026-08-24**, along with its Maestro e2e suite. The web
dashboard is the primary management surface and the app was always secondary. Three things decided
it: no competitor ships a first-party mobile management app, so it was never load-bearing for a
buyer; every feature added to the product cost a second implementation while it lived; and its e2e
suite could not run here anyway, because another project's Metro owned :8081.

It was briefly marked unmaintained-but-present. That is a worse state than either alternative — the
code goes stale while still looking like part of the product, and every reader has to work out
whether it counts. Deleting it is the honest version of the same decision.

**It is in git history** (`git log -- app/`), so restoring it is a checkout plus a catch-up pass
against whatever contract changes have landed since. That is the intended recovery path; nothing
about this is irreversible.

Closes out "mobile app: keep or drop?" in [REMAINING-WORK.md](REMAINING-WORK.md) §1, and moots both
"the mobile app still hardcodes Firebase" and the `nexus-app` Metro port conflict.

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

## Client-side keys

**The key's kind comes from its database row, never from its prefix.** The prefix is
attacker-supplied text; a token spelled `sb_srv_` whose row says CLIENT must be treated as CLIENT.
The routing test was correspondingly *widened* to `sb_` rather than turned into a prefix-to-kind
map — simpler than what it replaced, and it keeps the prefix from carrying any authority.

**Per-flag exposure lives on `flags`, not on `flag_env_configs`.** The config row is the one every
mutation locks `FOR UPDATE` and snapshots, so putting exposure there would mean toggling it creates
a version, enters the approval queue, and — worst — **gets silently reverted by a targeting
rollback**. Someone rolls back a bad rule from 3pm and unpublishes a flag from every browser as a
side effect. Whether a flag's existence is a secret is a property of the flag, not of one
environment's targeting.

**`client_side_available` defaults to false, and a SERVER key ignores it entirely.** Defaulting true
would publish every existing flag to the public internet the moment someone minted a client key.
The cost is that a new client integration starts with an empty flag list, which reads like a broken
integration — hence the callout in the mint dialog. The server-key exemption is what keeps the
fail-closed default from silently emptying every existing integration; it has its own test.

**The visibility filter applies to every evaluation endpoint, not just the bootstrap.** Filtering
only the payload the defect was reported against would make the flag a fig leaf: a public key could
enumerate hidden flags one `POST /api/eval/{key}` at a time. A hidden flag is *absent*, not
forbidden — the caller's default at 200 with `SDK_DEFAULT`, indistinguishable from a flag that does
not exist, which is both the fact worth protecting and the product's existing fail-safe rule.

**A client key is refused the rule-set bootstrap with a 403, not given a reduced 200.** A silently
smaller payload is how an SDK ends up with an empty store and serves defaults forever with nothing
surfaced. Failing loudly puts the problem at integration time.

**The evaluated bootstrap is a POST, and its ETag digests the body.** POST because attributes in a
query string end up in access logs, proxies, browser history and `Referer` headers; the conditional-
POST idiom already existed on the OFREP bulk endpoint. The body digest because a `stateVersion`
ETag is wrong in two directions once the payload is per-context: two contexts at one version give
different bodies under identical ETags, which a shared cache can cross-serve, and a user whose
attributes change is told 304 and keeps stale answers. Rendering the body to answer a 304 costs CPU,
not bandwidth. The response also carries `Cache-Control: private, no-store` and
`Vary: Authorization`, and echoes a `contextHash` so a client can prove a payload matches the
context it sent.

**A public key cannot report metric events.** Those rows are the input to an automated write path —
post enough `{"metricKey":"error"}` and a healthy rollout gets rolled back. Neither the SRM gate nor
the sequential test catches it: the allocation is fine and the evidence is real, it is just forged.
Eval events stay open, because rates are per distinct subject, so forging them inflates a
denominator and makes the monitor *less* likely to act. If browser metrics are ever genuinely
needed, the fix is a `key_kind` stamp on the rows plus excluding public-origin rows from the healing
loop — a column, not a policy argument.

**MOBILE is a reserved kind rather than an alias for CLIENT.** Not because its capabilities differ —
they are identical — but because revoking a key baked into a shipped binary locks out every
installed version until users update, where revoking a browser key costs a page refresh. That
belongs in the revoke dialog's wording and the audit trail.

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

## SCIM provisioning

**Users only. No `/Groups`.** Roles stay assigned in Switchboard. Mapping IdP groups onto role
assignments collides with the rule that permissions are a **union** across org, project and
environment scopes: removing someone from a group would have to work out which of their grants
came from that group and which a human made deliberately, and getting that wrong either strips
access someone still needs or leaves access they should have lost. That is a decision to make
explicitly, not to infer.

**No SAML, and SCIM changes nothing about that.** Enterprise SAML is still handled by delegating
to an OIDC-capable IdP — see the Identity section below. SCIM is provisioning, not
authentication, and the two are routinely confused when people say "SSO".

**Deactivation is a column, never a delete.** SCIM's `DELETE` and its `active: false` PATCH both
set `users.deactivated_at`. Audit entries name their actor and change requests name their
approver; deleting the person who did those things would orphan the record of who authorised a
production change — the opposite of what an org running SCIM for compliance reasons wants. A
timestamp rather than a boolean, so "when did they lose access" has an answer.

**A deactivated user authenticates with no authorities rather than failing to authenticate.**
This is the idiomatic Spring Security expression of "we know exactly who this is and they may do
nothing", and it yields the right status for free: every user-facing route requires `ROLE_USER`,
so the authorization layer answers 403. The two alternatives are both worse — throwing from
inside the authentication manager escapes the security chain's error mapping and surfaces as a
**500** (which is what the first implementation did), and a 401 would invite a client to
re-authenticate, which cannot help because the credential is fine and the account is not.

**Deactivating evicts `USER_IDENTITY` and `PERMISSIONS`, and that eviction is the
security-relevant half.** Identity resolution is cached for five minutes, so without it a person
deprovisioned by their IdP would keep authenticating for up to five minutes after their employer
believed access was revoked — precisely the window deprovisioning exists to close.

**Provisioning an existing person ADOPTS them rather than creating a second account.** People
sign in before anyone turns SCIM on; that is the normal order of events. A duplicate `userName`
is a 409 only when the person is already a member of *this* org.

**Authentication is a personal access token, not a new credential type.** DECISIONS.md already
records that a second authorization vocabulary is a second place for a permission bug to live,
and the existing advice for narrowing a token — create a user with a narrow role and mint it as
them — is exactly right for a provisioning integration. The token's owner needs
`MANAGE_MEMBERS`.

**The base path carries the org (`/scim/v2/orgs/{orgId}`).** SCIM has no notion of one, and every
IdP lets an administrator configure an arbitrary base URL, so this costs nothing and removes the
alternative — inferring the org from the token — which is ambiguous the moment a provisioning
user belongs to two.

**SCIM is not in the OpenAPI document, and that is deliberate.** It is its own specification with
its own envelope, media type, error shape and 1-based paging. Modelling it inside the document
that describes *this* product would put a second, foreign contract in the middle of it. The
contract implemented is RFC 7644; the reference is the RFC.

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

## The evaluation core

**Flag evaluation lives in its own module (`evaluation/`), not in the backend.** Extracted
2026-08-25, ahead of a Java SDK. The alternative was a second Java implementation of MD5
bucketing, sixteen operators, semver ordering and the restricted regex subset — which is
precisely the drift `spec/evaluation.md` and the conformance vectors exist to detect. Detecting
drift at test time is strictly worse than making it impossible: one implementation cannot
disagree with itself. The vectors still run, and now they run *once*, in the module both
consumers compile against.

**It has zero compile dependencies, and that is a hard rule rather than a nice property.** Not
Spring, not Jackson, not SLF4J. This module is what an SDK drops into someone else's
application, and a flag SDK that drags a dependency tree in with it is a flag SDK people route
around. Jackson is test-scoped, for reading the vector files. Anything that needs a dependency
belongs on the other side of the seam.

**`com.switchboard.domain.flag` is deliberately split across two modules.** The evaluation
module owns the value types the evaluator closes over (`Flag`, `Rule`, `Clause`, `ClauseOp`,
`TargetingConfig`, `Variation`, `WeightedVariation`, `IndividualTarget`, `RolloutOrVariation`,
`FlagKind`, `Segment`, `SegmentRule`); the backend keeps the repositories and the view/query
types (`FlagRepository`, `FlagDetail`, `FlagListItem`, …). Split packages are legal on the
classpath and both consumers use the classpath, so this works today.

The alternative was renaming the packages, which would have rewritten **178 import lines across
42 files** in the backend for no behavioural gain, and — worse — forced the server's hot path to
either adopt new type names everywhere or map domain types to evaluation types on every
evaluation. Keeping the names meant the extraction changed **zero** lines of backend source.

The cost is real and bounded: a split package cannot be used on the JPMS module path. Nothing
here declares `module-info.java`, the backend is an application rather than a library, and the
SDK depends on `switchboard-evaluation` alone — so the split is never observable to a consumer.
If someone ever needs the module path, the fix is the package rename that was skipped, and it is
mechanical.

**The backend image builds from the repository root.** It used to be self-contained under
`backend/`, and stopped being so the moment the evaluator became a sibling module: a
backend-only context cannot resolve `switchboard-evaluation`. The Dockerfile also copies
`sdk/java/pom.xml` with no sources, because Maven refuses to read the reactor at all unless
every module the aggregator declares exists — even when `-pl` selects a subset. CI missed this
locally because nothing here builds the production image by hand; the `containers` job caught it.

**The root `pom.xml` aggregates but does not parent.** The backend inherits from
`spring-boot-starter-parent` for dependency management, and the evaluation module must inherit
nothing at all — an SDK consumer should not be handed Spring's BOM through a parent POM.

**`cd backend && ./mvnw verify` is no longer the command; build from the repo root.** A
single-module build resolves `switchboard-evaluation` from the local repository rather than the
reactor, so it silently uses whatever was installed last, or fails outright on a clean checkout.
`make backend` therefore installs the core first (`make core`), and CI's `live` job uses
`install` rather than `package` for the same reason. This is the one ergonomic regression the
extraction caused, and it is written down here because the failure — a missing artifact — says
nothing about why.

---

## The Java SDK

**It does local evaluation, because remote evaluation already exists for free.** OFREP gives
Java an OpenFeature provider with no Switchboard-specific code, so a native SDK that merely
wrapped `POST /api/eval` would duplicate something free. What OFREP cannot do is evaluate in
process — no I/O per flag check, keeps working through a Switchboard outage, context attributes
never leave the box. That is the entire justification for the SDK, and it is why there is no
remote-evaluation mode: it would be the part OFREP already does better.

**It contains no evaluation logic.** Bucketing, operators, semver, the regex subset and the
precedence ladder come from `switchboard-evaluation`. The SDK's own code is the mapping from
the bootstrap wire format into that evaluator, plus transport and lifecycle. When reading this
SDK looking for "how does bucketing work here", the answer is that it does not work here.

**The conformance vectors are replayed through the wire format, not against the evaluator.**
Running them against `FlagEvaluator` in the SDK's suite would assert that a shared class equals
itself and pass no matter how broken the SDK was. `ConformanceThroughSdkTest` feeds each vector
in as a bootstrap payload through `BootstrapCodec`, which is the only place a Java SDK can still
disagree with the server. All 474 evaluation vectors run that way.

**An empty `rollout` array is a variation serve, not a rollout.** A live server serialises a
single-variation serve as `{"rollout": [], "variationId": "..."}` — the field present but empty
— while `RolloutOrVariation` requires exactly one of the two. Treating "present" as "is a
rollout" made **every real bootstrap payload unparseable** while every hand-written test fixture,
which omits the field entirely, parsed perfectly. Do not "simplify" that emptiness check away.

The general lesson is the one worth keeping: this class of bug is invisible to unit tests
written against fixtures the same author invented, and it is exactly what the live checks exist
for. It was found within minutes of pointing `LiveCheckIT` at a seeded stack.

**`failFastOnStart` defaults to false.** A flag SDK that refuses to start because Switchboard is
briefly unreachable has converted a degraded dependency into an outage of the application that
depends on it. The client starts, serves callers' defaults, retries in the background, and
reports `isReady() == false` so a health check sees the truth.

**A blank targeting key becomes a null context rather than an exception.** `EvalContext` refuses
a blank key by construction, which is right for the server — it validates at the API boundary
and a missing key there is a bad request. Inside an SDK it is a landmine: OpenFeature routinely
hands over a context with no targeting key, and converting eagerly threw straight through the
caller's flag check. The provider maps blank to null and the client reports `INVALID_CONTEXT`
while still serving the default. `EvalContexts.of("")` still throws, deliberately — a caller
writing that by hand has a bug, and failing at the call site names it.

**A rule using an unknown operator is dropped, not approximated.** A newer server can ship an
operator a deployed SDK has never heard of. Clauses are ANDed, so a rule that cannot be fully
understood can never be safely said to match; dropping it is the same outcome and is honest
about it. Segment rules are ORed, so dropping one narrows membership — also the conservative
direction.

---

## Implementation

**The dashboard does not use React Query.** Pages use `useState` + `useEffect` + async
`load()`. This matches the conventions of the author's other admin dashboard; consistency
across the two was worth more than the library. Do not introduce it for one page.

**Caching goes through the `CacheRegistry` / `SwitchboardCache` seam, which uses no proxies
at all** — Caffeine now and Redis later by configuration. This entry used to say "Spring's
cache abstraction"; that was the plan and it was **reversed during implementation**, because
Spring's abstraction is synchronous and `@Cacheable` on a `Mono`-returning method caches the
cold publisher rather than the value — it appears to work while doing nothing. The intent
survived intact (one seam, provider by `switchboard.cache.provider`, TTLs declared centrally,
a typed facade); only the mechanism changed. Names are a `CacheName` enum so a typo is a
compile error, and keys are Strings so they survive the `NOTIFY` invalidation channel.

Redis is deliberately *not* on the near-term list: Caffeine is correct for one instance and
`NOTIFY` already invalidates every instance, so correctness does not require a shared store.
Build the seam, choose the provider when the deployment shape justifies it. Full design in
[REMAINING-WORK.md](REMAINING-WORK.md).

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

## Performance measurement

**The load harness is open-loop by default, and that is not a style preference.** A closed-loop
generator stops sending while the server is stalled, so the stall never enters the sample — it
measures service time and calls it latency. Requests are scheduled at a fixed arrival rate and
timed from when they were *due*. Closed-loop mode still exists, but only as a saturation probe,
and its percentiles are labelled service time. Do not "simplify" the harness back to
concurrency-only; that would silently delete the tail.

**The generator measures its own noise floor rather than assuming it is zero.** The dispatcher
wakes on a 1 ms timer, so queue delay and event-loop lag both have a floor near a millisecond
against an infinitely fast server. The first version of the harness compared lag against zero
and reported that every run above 500/s was "generator-bound" — the warning fired on the
instrument, not the server. A calibration pass now runs the identical dispatch loop against a
transport that resolves on the microtask queue, and warnings are raised against that measured
floor. An instrument that cannot state its own error cannot support a published percentile.

**Benchmark the packaged jar, never `make backend`.** `mvnw spring-boot:run` passes
`-XX:TieredStopAtLevel=1`, capping the JIT at C1. That is right for a dev loop and wrong for a
measurement, and it is invisible — the server works perfectly, just permanently slower than a
deployment. `java -jar` is also the shape CI's `containers` job runs.

**Reported throughput is a floor, not a ceiling.** The 28k eval/s figure was taken with the
generator and the JVM sharing ten cores, and the harness reported itself lag-bound at that
rate. Quoting it as the server's maximum would be exactly the kind of number
[competitive-gaps.md](competitive-gaps.md#latency) criticises the rest of the market for. It is
recorded as "at least this, on this rig".

**Load runs use their own database, not the dev one.** Millions of generated event rows in the
development database would outlive the run and quietly change every later measurement — and
`CLAUDE.md` already notes that dev-database accumulation is a recurring nuisance. The harnesses
target `switchboard_load` on the same Postgres instance.

---

## Metric definitions

**A metric declares which way is good, and both questions are asked of it.** The monitor used to
know exactly two keys, and the direction was implicit in which one it was: `error` was only ever
tested for degradation, `conversion` only ever for improvement. That implicitness hid a real
blind spot — **a variation that destroyed conversion was never healed**, because nothing ever
asked whether conversion had regressed. Every defined metric is now tested in both directions.

The consequence to know about: with two metrics that is four hypotheses per challenger where it
was two, so each e-BH family is larger and the correction correspondingly stricter. That is the
right trade; the alternative is not asking the question.

**`tau` is per metric, and must never be fitted to data.** A 1% shift means something different
for an error rate than for a refund rate, which is why it moved from two global constants onto
the metric. The prohibition is unchanged and load-bearing: deriving tau from the effect being
measured makes the constant a function of the sample and destroys the supermartingale property
that makes repeated looks safe.

**`autoAct` exists so a metric can be watched without moving traffic.** A team measuring
something noisy wants to see it in the readout without it triggering rollbacks.

**Epoch evidence is keyed by DIRECTION as well as metric, and V11 exists because of it.** The
supremum table was keyed `(environment, flag, epoch, metric_key, variation)`, which was
sufficient only while the metric key uniquely determined the direction. Once both directions are
tested per metric they collide on that key and **share a running supremum**: the improvement
hypothesis reads back the evidence the degradation accumulated, concludes it has crossed, and
recommends *ramping a variation that is in fact broken* — reported with an always-valid p-value
and an e-BH family size, which is what makes it dangerous rather than merely wrong. The finding
dedupe key had the same hole and gained direction too.

Caught by `RolloutScanIT`, which asserts a rescan is a no-op and instead saw a second finding.
The existing test caught a new bug in code it was not written for, which is the argument for
keeping assertions like "and doing it again changes nothing".

**Metric keys are not a foreign key on `metric_events`.** Events arrive from SDKs before anyone
defines a metric, and refusing telemetry for an undefined key would discard data that becomes
meaningful the moment someone defines it. Deleting a definition likewise leaves its events.

**New projects are seeded with the two built-ins.** V10 seeds every project that existed when it
ran; without seeding at creation a project made afterwards would have no metrics, and the monitor
would silently do nothing for it — indistinguishable from "no traffic yet".

**`VariantStats` keeps its `errorRate` and `conversionRate` fields.** Generalising the domain did
not have to break a client contract the dashboard reads, so it did not. Those two accessors name
the built-in keys explicitly and are marked for display only; everything that makes a decision
goes through the metric map.

---

## The rollout scan

**Candidates are measured with `flatMapSequential`, not `flatMap` and not `concatMap`.** It was
`concatMap` — strictly serial — so a scan cost the sum of its aggregations: 40.8 s for eight
flags, and over fifteen minutes at 2 M events each. Concurrency of four takes that to 19.2 s.

`flatMapSequential` rather than plain `flatMap` because it runs concurrently while still emitting
**in order**, and order is load-bearing here: `decide()` indexes e-BH's `survives[]` array back
against family position and breaks ties on it, so an unordered merge would leave every decision
identical but the reported ranks non-deterministic between runs. That is the kind of difference
nobody notices until they are comparing two findings and cannot explain why the numbers moved.

**Four, and bounded.** Eight measured *worse* than four (21.8 s against 19.2 s): the work is
database-bound, so past a handful of concurrent aggregations Postgres is the constraint and more
fan-out only adds contention. Four also sits below the default connection-pool size of ten, so a
scan cannot starve the evaluation hot path of connections while it runs.

**Raising `work_mem` for the aggregation is available and OFF by default.** It looked like the
cheapest win in the system and is not a general one. At 2 M events for one flag it helped — the
~31 MB sort stopped spilling and the query went 4.4 s to 3.6 s. At 500 k events per flag it made
the whole scan *slower* (44.1 s against 40.8 s), because at that size the sort never spills and
there is nothing to buy. `work_mem` is per sort node per connection, so a raised default would
multiply by the scan concurrency and charge every deployment memory to benefit only some. Blank
by default; set `switchboard.rollout-monitor.aggregate-work-mem` after measuring your own volume.

When it *is* set, the `SET LOCAL` and the query must run on the same connection or the setting
applies to a connection that returns to the pool and the query runs at the default anyway — a
tuning change that looks applied and does nothing. The transaction is what pins them together.

---

## Dashboard list caching

**Invalidation is exact; the TTL is only a backstop.** The flag and change-request list caches
are cleared by every write that could change them, so a stale list is not something a reader is
expected to tolerate for the length of the TTL — it should never be served at all. Five minutes
is therefore about surviving a dropped `NOTIFY`, not a judgement about acceptable staleness.
Read `ListCacheInvalidator` before changing any of this; the rule it exists to hold is below.

**Eviction happens AFTER the transaction commits, never inside it.** Evicting inside opens a
race with a window wide enough to hit: the evict runs, a concurrent reader misses and re-loads,
the reader caches pre-commit data, and the commit then lands with no further eviction — leaving
a cache stale indefinitely with no error and nothing in the log. This is why invalidation is
not simply called from `AuditWriter`, which would otherwise be the one place every audited
action passes through.

**A rename must evict, and would have been missed.** A PATCH of a flag's name or tags writes an
audit row and bumps no state version, so it fires no `flag_change` notification. Hanging list
invalidation off that existing signal is the obvious design and is wrong: it would serve a stale
name for the whole TTL and look correct in any test that did not wait five minutes. Pinned by
`ListCacheIT.aRenameIsVisibleImmediatelyEvenThoughItBumpsNoStateVersion`.

**The lists are cleared wholesale rather than evicted by key.** A page is keyed by its filters
and cursor, so one flag changing invalidates an unknowable set of keys — every page whose filter
that flag matched, which cannot be computed without running the queries. Blunt is correct;
enumerating would be guesswork. Affordable because the writes are human-paced.

**The cached page is not keyed by user, and that is safe only because of ordering.** Access is
checked *before* the cached value is handed over, and the underlying query takes no user, so
every project member gets the same page. Moving the permission check inside the loader would
cache the first caller's entitlement along with the data — the same class of bug as a
`stateVersion` ETag on a per-context body.

**The audit list is deliberately NOT cached**, reversing the plan that grouped it with the other
two. Audit rows are written from 18 call sites and the list is read from one: a cache
invalidated by essentially every write in the product has a hit rate bounded by its own
invalidation rate, so there is little to win, and 18 invalidation points is 18 chances to miss
one. The failure mode there is a silently stale audit trail, which is the one kind of staleness
that reads as "the audit log is broken" rather than "the page is slow". Audit performance, if it
ever matters, wants an index or a narrower projection.

---

## Audit export and retention

**Audit retention defaults to OFF (`switchboard.audit.retention-months=0`, keep forever), which
is deliberately the opposite of `switchboard.events.retention-months=3`.** Event rows are
telemetry: high-volume, individually meaningless, and expiring them is housekeeping. Audit rows
are low-volume, individually meaningful, and frequently the thing a compliance review or an
incident post-mortem actually needs. A product that silently deleted them after three months
because that was a convenient default would be destroying the record its own governance features
exist to produce. Setting a window should be an act with an owner, not a default nobody chose.

**Audit pruning deletes in bounded batches; event retention drops partitions.** They look like
the same job and are not. `eval_events` and `metric_events` are partitioned, so retention is an
unlink — measured at 259 ms for an 828k-row, 91 MB partition, flat in row count.
`audit_entries` is not partitioned, so pruning is a row-wise `DELETE` whose cost scales with the
rows removed; one unbounded statement over a long-neglected table would hold locks and bloat the
WAL for as long as it ran. Whatever a run does not reach, the next run reaches.

**The export is NDJSON, not a JSON array.** An array obliges the consumer to hold the entire
export in memory to parse it, which defeats the purpose — the org that most needs an export is
precisely the one whose audit table will not fit in a response body. One object per line streams
end to end, and nothing in the controller collects the `Flux`.

**The export is deliberately not paginated, and is ordered oldest-first.** Not paginated because
an export is asked for once and expected to be complete, so a cursor would only add a way to
miss rows between pages. Oldest-first is the opposite of the paged feed and is the useful order
for appending to a file or replaying into a warehouse; it also makes a re-export a superset with
a stable prefix.

**An unparseable `since` is a 400, never a silent full export.** Quietly exporting everything
when the caller asked for a window is how somebody ends up with a download they did not ask for.

**CSV values are RFC 4180 quoted because `reason` is free text a user typed.** A comma shifts
every later column; an embedded newline corrupts every later *row*. Both are pinned by a test
that writes all three hazardous characters through the API.

**The export controller is hand-written rather than implementing its generated interface**, and
is tagged separately in the OpenAPI document so the generated interface is left unimplemented —
exactly as `StreamApi` is. A generated method is fixed to one response type; this answers one
operation as either NDJSON or CSV, streamed. The path and parameters stay in the spec.

---

## Webhooks

**Deliveries are a transactional outbox.** The `webhook_deliveries` row is inserted in the SAME
transaction as the flag write that caused it; delivery is attempted after commit. Enqueueing
after commit instead is simpler and loses events whenever the process dies in that window —
which is precisely the moment an operator most wants to know what changed. The cost is one
INSERT per matching webhook inside a flag mutation, and flag mutations are human-paced.

**The signature's timestamp is inside the MAC, not merely alongside it.** Signing the body alone
produces a token that stays valid forever: anyone who observes one delivery can replay it
indefinitely, and a replayed "kill switch released" is a real incident rather than a curiosity.
The header is Stripe's shape (`t=…,v1=…`) because that is the one receivers already have library
code for, and `v1` is a version prefix so a future scheme can be sent alongside during a
migration rather than breaking every consumer at once.

**An empty event-type filter means every event, not none.** The opposite reading would make a
newly created webhook silently deliver nothing, which reads as a broken integration rather than
as a filter nobody set. Resource filters (project, environment) only ever narrow.

**A 4xx from a receiver is retried, not abandoned.** A receiver answering 404 or 401 is usually
mid-deploy or mid-rotation rather than permanently wrong, and the six-attempt ceiling already
bounds the cost of being wrong about that.

**URL validation is validation, not an SSRF control**, and the distinction is easy to mistake.
Blocking private address ranges would break every self-hosted deployment whose receiver is on
the same network — which is most of them — and would not work anyway, since a DNS name resolving
to a private address passes any check made here. A deployment that needs egress restrictions
imposes them at the network layer, where they can actually be enforced.

**The signing secret is stored as issued, unlike an SDK key or a PAT.** Those are one-way hashes
because the server only ever needs to *check* them. HMAC needs the key itself, so there is no
digest that would do. It is returned once, at creation, and never listed.

**The old `org.<id>.notifications.webhook` setting was migrated, not dropped.** V8 turns any
configured URL into a real webhook row subscribed to `rollout.finding`, so an org that relied on
it keeps receiving notifications — now signed and retried. Existing receivers start getting a
signature header they were not previously sent, which is additive: an unverified receiver
ignores it.

---

## Deployment

**Dashboard configuration is resolved at runtime, not at build time.** Vite folds every
`VITE_*` into the bundle as a literal, which would pin an image to one API URL and one IdP —
staging and production would be different images of the same commit, and "did we deploy the
right build" becomes a question anyone can get wrong. The container writes `/config.js` from
its environment at start-up and `src/lib/runtimeConfig.ts` layers it over `import.meta.env`.

**`VITE_AUTH_PROVIDER` stays a build argument, and a runtime override of it is an error
rather than a no-op.** It decides which provider is *compiled in*: `src/auth/index.ts` sits
its two dynamic imports either side of a literal comparison, so a default build does not
contain `oidc-client-ts` and an `oidc` build does not contain Firebase. Silently ignoring an
override is the worse failure — the operator sets the variable, sees the login page render,
and finds out at the first sign-in attempt.

**The production compose file sets `name: switchboard-prod`, and that line is load-bearing.**
Compose derives the project name from the directory when a file does not set one, so both
compose files would be `switchboard` and `up` on the production one recreates the
*development* postgres container in place, against the development volume, with production's
credentials. Verified by doing it accidentally.

**The management port is not published, and its endpoints are `permitAll`.** The port, not
the filter chain, is the boundary. Anything that needs to scrape it joins the network.

**Retention is configuration (`switchboard.events.retention-months`), clamped at one month.**
Whole partitions are dropped, so lowering it is immediate and destructive with no archive
step. The clamp is not a style choice: the current month's partition is the one being written
to, and dropping it would delete live data rather than expire old data. Epoch evidence is
pruned on the same window deliberately — evidence about events that no longer exist cannot be
rechecked.

**`firebase-admin` is an optional dependency, so the packaged jar cannot talk to the auth
emulator — and refuses to start rather than failing later.** The emulator issues *unsigned*
(`alg: none`) tokens that no JWKS verifier will accept; only the Admin SDK will. Production
Firebase is an ordinary OIDC issuer and needs none of it, so a deployment on Okta, Auth0, Entra
ID or Keycloak should not carry the SDK. Spring Boot's repackaged jar leaves optional
dependencies out, which means:

- `./mvnw spring-boot:run` (what `make backend` does) has it — the full compile classpath.
- `java -jar target/*.jar` with `FIREBASE_AUTH_EMULATOR_HOST` set fails at startup with a
  message naming both ways out.

That startup failure is the design working. The alternative — starting fine and rejecting every
login with a 401 — is the failure mode that variable already causes when it is *absent*, and it
is documented as costly precisely because it is invisible. **CI's `live` job therefore uses
`spring-boot:run`, not the jar**, and its `containers` job runs the jar with no emulator at all,
which is the production shape.

**The live check scripts do not run against a deployment, and that is correct.** All of them
authenticate with `Bearer dev:<email>`, which exists only under the `local` profile. Against
a real environment they 401 on the first call. They belong in CI, where the stack is local by
construction, and they run there on every pull request.

---

## Known-good states that look like bugs

- **`/actuator/health` 404s on port 28080.** Actuator moved to its own port; probes must
  target `MANAGEMENT_PORT` (default 28081). Not a broken health check.
- **`dashboard/scripts/auth-check.mjs` fails its OIDC leg unless the backend has a second
  provider configured.** The script prints the exact command. The Firebase leg passing alone
  is expected on a default stack.
- **The seeded demo produces optimize findings but no healing finding.** The error-heavy flag
  (`payment-provider-v2`) is kill-switched by the seed on purpose, to demo the kill switch, and a
  killed flag is correctly not a live rollout. `TESTING.md` has the drill that produces one by
  hand.
- **A fresh `make seed` shows `itemsScanned=0` if the version rows were not backdated.** The
  monitor measures from the allocation epoch, and the seed writes configs *now* while ingesting
  48h of backdated traffic. The seed backdates the rollout flags for exactly this reason; the same
  trap catches anyone hand-building a scenario.
- **`java -jar` refuses to start with `FIREBASE_AUTH_EMULATOR_HOST` set.** The optional
  `firebase-admin` dependency is not in the packaged jar. Use `make backend`. See Deployment.
- **The live check scripts 401 against anything but a local stack.** Dev tokens are
  local-profile-only. See Deployment above.
- **AI endpoints return `503 AI_UNAVAILABLE` without an `ANTHROPIC_API_KEY`.** Intended, and
  the UI renders it as an explanation rather than an error. Healing, optimizing and the stale
  sweep all work without a key.
