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
