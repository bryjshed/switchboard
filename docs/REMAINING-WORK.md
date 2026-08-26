# Remaining work

Everything not yet built, with why it matters and what it costs. Companion to
[competitive-gaps.md](competitive-gaps.md), which is the market research this is derived
from — read that for who has each feature and how the market treats it.

Effort is **S** (a day or less), **M** (a few days), **L** (a week or more), measured
against the architecture as it stands.

**Status of the product today.** Evaluation core (528, shared by the server and the Java SDK), backend (114 unit + 111 integration), TypeScript SDK (562), Java SDK (509 + a live check), MCP server (7), web dashboard (337),
an evaluation spec with 507 conformance vectors executed by both the server and
the SDK, and seven live-check scripts against a running stack.

**The Expo mobile companion was deleted on 2026-08-24** — see
[DECISIONS.md](DECISIONS.md#product-scope). Nothing below carries a mobile implementation cost, and
it is in git history if it is ever wanted back.

Working end to end: flags, targeting, percentage rollouts, versioning, audit, rollback, SSE
delivery, the AI layer (natural language, healing, optimizing, stale sweep), OFREP,
scoped RBAC, approval workflows, and provider-agnostic authentication on both the backend
and the dashboard.

**Recently landed, so it is no longer a gap:** authentication is no longer tied to Firebase.
Identity is `(issuer, subject)` in `user_identities`, providers are configuration, and both
the backend and the dashboard work with any OIDC provider — proven against a real
non-Firebase issuer, not just unit-tested. See `backend/README.md` and `dashboard/README.md`.
Also landed: **the repo is committed** — the tree is under version control on `main`
(2026-08-24), so the former top item here (an entirely uncommitted working tree) is gone.

**Ordering note.** Sections below are the original backlog; items that have landed are struck
through in place rather than deleted, so the reasoning stays next to the work.

**For anyone picking this up:** read `CLAUDE.md` first — it carries the environment traps
(Java 25, the Firebase emulator host variable) that have each cost real time. This document is what is left to build.

---

## 1. Blocked on a decision or a credential

Nothing here is a technical problem. Each needs a human.

| Item | What is blocked | Why it matters |
|---|---|---|
| **No `ANTHROPIC_API_KEY`** | Natural-language flag creation | The Claude adapter, its forced-tool schema, and the calm `503 AI_UNAVAILABLE` degradation are all built and tested, but the real prompt-to-diff-to-apply loop **has never executed**. Everything else in the AI layer (healing, optimizing, stale sweep) works without a key. |
| **Visual review in light and dark** | Design sign-off | Never done. The dashboard uses semantic tokens only and is theme-aware by construction, but nobody has looked at the pixels. |

---

## 2. Defects in what already ships

These are not missing features. They are things Switchboard already claims to do, done
wrong or incompletely — cheaper to fix now than to explain later.

### ~~The peeking problem~~ — `RolloutMonitorService` · **Landed 2026-08-24**
The healing/optimizing loop ran a fixed-horizon two-proportion z-test repeatedly on a
schedule, which inflates the false-positive rate without bound. Now a Gaussian-mixture SPRT
reported as an e-value, so Ville's inequality bounds the error however often the monitor looks.
**The acceptance property: the scan interval no longer appears in any decision.**

Also landed with it, and mostly larger than the defect this item named:

- **Rates are proportions of distinct subjects, not ratios of event counts.** The denominator
  used to be evaluation events, so a server SDK evaluating in a hot loop made one unhappy user
  look like a thousand — understating the variance by roughly the evaluations-per-subject and
  inflating z by roughly its square root. **No sequential statistic fixes that**; an
  anytime-valid test on those counts is rigorously testing the wrong null.
- **Evidence accumulates from the allocation epoch** rather than a rolling 48h window. A
  rolling window is not a filtration, so the argument that makes repeated looks safe does not
  apply to one.
- **The baseline comes from configuration**, not from whichever arm had the most traffic.
- **An SRM gate** (Dirichlet-multinomial e-value) suppresses a flag's comparisons when traffic
  did not arrive as configured, counting only rollout-served subjects so a targeting rule does
  not trip it.
- **e-BH across the environment, per direction**, replacing an uncorrected max-over-challengers
  that was hiding inside a tie-break.
- **The dedupe key is epoch-anchored.** It used to end in the current hour, so one incident
  could file up to 48 findings — and the old rescan test only passed because it re-ran inside
  the same wall-clock hour.
- Constants are now `switchboard.rollout-monitor.*` rather than `private static final`.

Reasoning in [DECISIONS.md](DECISIONS.md#rollout-monitoring), operator-facing summary in
[ai-layer.md](ai-layer.md). `PeekingTest` asserts both that the new rule holds its error rate
across 48 looks at A/A traffic (0.0025 against alpha 0.01) and that the old one does not
(0.0090 against a nominal 0.00135) — the second is what gives the first meaning.

### ~~Client-side exposure in the bootstrap payload~~ · **Landed 2026-08-24 (server side)**
`GET /api/eval/bootstrap` returned the full rule set and every segment's raw `includedKeys` to
any SDK-key holder, and there was exactly one kind of key — so there was no way to hand a
browser a key without handing it the entire targeting configuration and every cohort's
membership list.

Now: `sdk_keys.kind` is `SERVER` | `CLIENT` (`MOBILE` reserved), `flags.client_side_available`
gates per-flag exposure and **defaults to false**, and `POST /api/eval/bootstrap` returns
evaluated values — served variation only, no rules, no segments, no sibling variations.

Details worth knowing before changing any of it:

- **The filter applies to every evaluation endpoint**, not just the bootstrap. Filtering only
  the bootstrap would make the flag a fig leaf, since `POST /api/eval/{key}` would still
  confirm a hidden flag exists and say what it serves. A hidden flag reads as *absent*, not
  forbidden — same default, same `SDK_DEFAULT`.
- **The ETag is a body digest, not the `stateVersion`.** Once the payload depends on the
  caller's context, a version ETag is a cross-user leak: two contexts at one version produce
  different bodies under identical ETags. The same bug existed on `POST /ofrep/v1/evaluate/flags`
  and is fixed there too — observable as one 200 instead of a 304 for a provider holding a
  cached ETag.
- **A client key is refused `POST /api/events/metrics`.** Those rows drive automated rollbacks,
  so accepting them from a key anyone can read out of a JS bundle is accepting unauthenticated
  flag changes. Neither the SRM gate nor the sequential test catches forged-but-real evidence.
- **A server key is unaffected** and still sees every flag regardless of the new column — the
  guarantee that makes the fail-closed default safe, asserted by `ClientSdkKeyIT`.

Remaining: the TypeScript SDK has no client mode yet, so a client key is usable from `fetch`
but not yet from the first-party SDK. **S–M**

### Smaller
- ~~**Flag list pagination**~~ **Done 2026-08-25.** The cursor existed end to end; the page dropped
  it and silently truncated at 50. Now a Load-more button, matching the three other pages that
  already had it.
- ~~**429 is not implemented**~~ **Done 2026-08-25.** A per-credential token bucket, in front of
  authentication so a client spraying invented keys is refused before it reaches the database.
  Sends a real `Retry-After`, which OFREP has always documented and nothing could produce.
  **Per instance:** two instances mean two buckets, and this is the first thing here that genuinely
  wants a shared store.
- ~~**Dashboard ships as one 589 kB chunk**~~ **Done 2026-08-25.** Route-level lazy loading: 49
  chunks, largest 352 kB, with Firebase (104 kB) now deferred to its own. Login and the auth
  callbacks stay eager — they are the first paint for a signed-out visitor, so a chunk request in
  front of the login form would be latency for nothing.
- ~~**`listEnvironments()` is dead code**~~ — removed; environments arrive embedded in `Project`.
- **`AiProposal` / `ChangeRequest` convergence, steps 2–3.** Step 1 is done — AI applies now
  route through the approval gate. Remaining: make `ai_proposals` a *source* table and
  `change_requests` the single lifecycle for every proposed write, then collapse the status
  enums (which touches a client contract, so last). **M**

---

## 3. Caching — **largely landed 2026-08-25**

This section was written when one environment snapshot cache did all the work and nothing else
was cached. Five caches and a seam later, most of it is done; the original reasoning is kept
below with the outcome marked against it, because the *arguments* for each cache are what a
reader needs when deciding whether to change one.

### What exists
- **`EnvSnapshotCache`** — now on the shared `CacheRegistry` seam (it was migrated first, on
  purpose: it already worked, so the seam was proven against something known-good before anything
  else depended on it). 10,000 entries, 5-minute expire-after-write, invalidated across instances by
  the Postgres `NOTIFY` listener. Covers the hot path: evaluation, bootstrap and the SSE payload all
  read through it, with single-flight per key so an eviction on a busy environment does not stampede
  the database.
- **HTTP validation caching** — `ETag` / `If-None-Match` returning 304 on the bootstrap and
  OFREP bulk endpoints.
- **Client-side** — the TypeScript SDK holds config in memory and evaluates locally, so a
  flag check costs nothing after the initial load.

### What was not cached, and where it hurt

All but the last of these landed on 2026-08-25. The measurements are live, not projected.

**~~SDK key resolution runs a SQL join on every evaluation request.~~ Done.** `sdk_keys` →
`environments` → `projects`, per request, on the single hottest path in the product. At any
meaningful evaluation QPS this is the database's dominant workload, and it is pure overhead:
an SDK key's mapping to an environment changes only when a key is minted or revoked. Cache
it keyed by the key hash, invalidated on those two events. **S** · **highest-value cache
work.** Measured after: 20 evaluation requests, **1** database resolution.

**~~RBAC permission resolution runs a union query per authorization decision.~~ Done.** Every
management request resolves permissions across org, project and environment scopes, and a
single dashboard page load makes several. Cache per `(user, scope)` with invalidation on
role-assignment change. **S–M** Measured after: 15 flag-list requests, **0** extra
resolutions. Shortest TTL of any cache (30s), because staleness here means someone keeps access
that was just taken away.

**~~Identity lookup per authenticated request.~~ Done.** Same shape of fix. Absence is
deliberately *not* cached for identity or permissions: "no such user" and "no standing" both stop
being true the moment somebody signs in for the first time or is granted a role.

**~~JWKS fetching in the new OIDC provider.~~ Already implemented; verified, not rebuilt.**
Nimbus's own cache plus a decoder-rebuild TTL (default 15 minutes) in `OidcIdentityProvider`. The
instruction to check rather than assume was the right one — the answer was simply yes.

**~~Rollout statistics are aggregated from scratch every time.~~ Done**, short TTL. The Monitor screen and every
`rollout-scan` run a `GROUP BY` across the partitioned event tables over a 48-hour window.
This is the most expensive query in the system and it is recomputed on every page load.
Needs either a short-TTL cache or incremental rollups. **M**

**~~No negative caching.~~ Done for SDK keys**, on a shorter TTL than positive entries. An
unknown flag key or an invalid SDK key hit the database every time. Besides the waste, a scanner spraying bad keys turns into unbounded database load —
this is a denial-of-service vector as much as a performance one. **S**

**Dashboard list queries** — flags, audit, change requests — are **still uncached**, and
deliberately last: they are human-paced, and a stale flag list is a worse trade than a fast one.
The only item in this subsection not done. **S**

**Measured 2026-08-25, and it moves this item up.** `GET /projects/{id}/flags` is the slowest
path in the product: p50 2.87 ms, **p99 73.8 ms**, against 4–8 ms at p99 for everything served
through the cache seam — an order of magnitude, and it is the page every session opens on. The
"human-paced" argument for deferring it stands; the "it is probably fine" half of it does not.
See [PERFORMANCE.md](PERFORMANCE.md#latency). The TTL still has to be justified rather than
picked: staleness here is a flag list that disagrees with what is live.

### The architecture — as built, and where it departed from this plan

**The original decision here was "go through Spring's cache abstraction". It was reversed
during implementation, and the reversal is the most useful thing in this section.**

The intent survived intact: one seam, provider chosen by `switchboard.cache.provider`, cache
names/TTLs/sizes declared centrally, a typed facade rather than `@Cacheable` strings scattered
across call sites, and two tiers declared per cache. What changed is the mechanism —
`CacheRegistry` / `SwitchboardCache` is a **reactive seam that uses no proxies at all**, rather
than `@EnableCaching` over `org.springframework.cache`.

The reason is the trap below. Spring's abstraction is synchronous, and every workaround for that
on a `Mono`-returning method costs more than the abstraction is worth. Names are a `CacheName`
enum, so a typo is a compile error rather than a startup one; keys are Strings, so they survive
the `NOTIFY` invalidation channel intact. Full reasoning in [DECISIONS.md](DECISIONS.md).

### The trap that bit — and how the seam avoids it

**`@Cacheable` on a method returning `Mono` caches the cold publisher, not the value.** Every
subsequent caller gets a publisher that re-executes on subscribe, so the cache appears to work
while doing nothing — or worse, the cached `Mono` is consumed once and later subscribers see
empty. This is the single most dangerous thing in this whole section, because it fails *open*:
nothing errors, the code looks right, and the cache is simply inert.

**Do not reach for `@Cacheable` here.** The seam sidesteps it — and the two below — by not using
proxies. The test that proves it asserts the loader ran **once** across two subscriptions, and it
exists.

Two more that the proxy-free design also disposes of:

- **Self-invocation bypasses the proxy.** With `@Cacheable`, cached methods must live in their own
  `@Component` loader bean that the service calls, never on the service itself; a same-class call
  goes straight past the advice and silently does nothing. No proxy, no trap.
- **Key types must survive the invalidation channel.** Invalidation rides Postgres `NOTIFY`, whose
  payload is text. Stringified UUIDs on one side and `UUID` objects on the other means eviction
  quietly misses and instances serve stale config indefinitely. Settled by making keys Strings
  throughout, pinned by a test.

### When Redis actually earns its place

**Still not yet, and the question now has a sharper answer than when this was written.** Caffeine
is correct for a single instance and `NOTIFY` already invalidates every instance, so correctness
does not require a shared store — a shared cache would be a correctness *equal* and a latency
loss. Redis earns its place when there are enough instances that cold starts hurt (a new pod
rebuilds every cache from the database), or when something genuinely needs shared state.

That second condition now has exactly one occupant: **the rate limiter**, added 2026-08-25 and
deliberately *not* on the cache seam. The seam is read-through over values that can be recomputed;
a rate-limit bucket is mutable state that must not be. It is per-instance, so two instances mean
twice the configured rate — honest rather than ideal, and the first thing here that genuinely
wants a shared store. The order to work in is written down in
[DEPLOYMENT.md](DEPLOYMENT.md#scaling-past-one-node): divide the limits by the instance count,
then move migrations out of boot, then reach for Redis.

There *is* a deployment story now, which is what this paragraph used to be waiting on. **The seam
was built; the provider is still a configuration change away.**

When it does happen, the serializer is where the time goes: Java records are final, so
polymorphic type handling has to be configured deliberately; unknown-property failures must
be tolerated or a rolling deploy breaks the moment two versions share a cache; and
replicated entries need a real TTL rather than living forever. **M**

**~~No cache observability.~~ Landed 2026-08-24.** `micrometer-registry-prometheus` is wired
and `/actuator/prometheus` is served on a **separate management port** (`MANAGEMENT_PORT`,
default 28081), so the scrape endpoint is not on the public listener. `EnvSnapshotCache` now
calls `recordStats()` — without it every meter reads zero, which looks exactly like a working
cache with no traffic — and is bound under cache name `envSnapshot` for hit rate, evictions,
load latency and size. The two paths this section argues for caching are timed:
`switchboard.auth.sdk_key.resolve` and `switchboard.access.permissions.resolve`. SSE
subscribers and tracked environments are gauged, the second so the never-evicted sink map
shows up as a widening gap against the first. `MetricsIT` asserts each meter **moves**, not
merely that it exists.

**The management port's endpoints are unauthenticated, but not for the reason first written
here.** The claim in this spot used to be that the management child context does not inherit
`SecurityConfig`'s filter chain. **That is false** — it does, which is exactly why `health`,
`info` and `prometheus` have to be named `permitAll` there, and why Prometheus returned 401
until they were. The boundary is the *port*, not the filter chain: bind it to the pod or host
network and never publish it. Now restated in [DEPLOYMENT.md](DEPLOYMENT.md#the-management-port),
and `docker-compose.prod.yml` does not publish 28081.

**The SDK has no local persistence.** Config lives in memory only, so a process restart
always requires a successful network fetch before the first evaluation is accurate. If
Switchboard is unreachable at exactly that moment, the application serves its own defaults
rather than the flags you last configured. LaunchDarkly's SDKs persist last-known config to
disk for this reason. **M**

**No CDN or edge story.** The bootstrap payload is per-environment and highly cacheable, but
nothing is set up to serve it from an edge. Related to the multi-region non-goal below.
**L**

### Suggested order within this area
1. ~~**Metrics**, so everything after is evidence-driven rather than reasoned.~~ **Done** —
   see above. The remaining items below are now measurable before and after.
2. ~~**Introduce the cache abstraction**~~ **Done** — a reactive `SwitchboardCache` seam rather
   than Spring's synchronous one; see [DECISIONS.md](DECISIONS.md) for why the mechanism changed
   while the intent did not.
3. ~~**The SDK-key cache**, the largest single win.~~ **Done** — measured live at 20 evaluation
   requests to **1** database resolution (19 hits). Invalidated on mint and revoke, across
   instances, over a second `NOTIFY` channel.
4. ~~**Negative caching**, which closes the denial-of-service vector.~~ **Done** for SDK keys, on a
   shorter TTL than positive entries.
5. ~~**Permissions**, then **identity**, then **rollout stats**.~~ **Done.** Measured live: 15
   repeated flag-list requests add **0** permission resolutions. Permissions carry the shortest TTL
   of any cache (30s) because staleness there means someone keeps access that was just taken away,
   and grants, revocations and membership changes evict on top of that — `PermissionCacheIT` holds
   revocation-takes-effect-immediately in place. Absence is deliberately not cached for permissions
   or identity: "no standing" and "no such user" both change the moment somebody is granted a role
   or signs in for the first time.

Redis is not on this list on purpose. The seam makes it a configuration change whenever the
deployment shape justifies it.

---

## 4. Now — what a serious buyer expects and we lack

### ~~Richer targeting~~ · **Landed 2026-08-25**
"Release to app version ≥ 4.2.0 on iOS" is one rule now, verified live. Typed attributes
(string / number / boolean / array), sixteen operators across text, numeric, time and semver, and
per-clause `negate`.

**Clause values stayed strings and the operator decides how to read both sides.** That keeps the
wire stable and a rule legible in a form, a diff and a JSON blob — one rule to learn instead of a
type system to negotiate.

Landed spec-first, in one commit: `spec/evaluation.md` sections 1.1, 3.1, 3.2 and a new 3.3, plus
**306 generated vectors** executed by both the Java server and the TypeScript SDK. The vector
generator that `spec/README.md` and `CLAUDE.md` had been promising since the spec was written now
exists, and the runners no longer hardcode a count.

Two things worth knowing before relying on them, both pinned by vectors: a **negated clause on a
missing attribute is TRUE** (LaunchDarkly's semantics, and what the English means), and `MATCHES` is
a **restricted regex** — unanchored, no lookaround, no backreferences, 512-character cap — both to
stop a pathological pattern stalling evaluation and so Java and JavaScript cannot disagree.

`NOT_SEGMENT_MATCH` is deprecated but still accepted, normalised at read time to `SEGMENT_MATCH` +
negate, so configs written before negation existed evaluate identically without being rewritten.

### ~~MCP server~~ · **Landed 2026-08-25**
A new `mcp/` workspace: twelve tools over the existing REST API, no backend surface of its own,
authenticated by a personal access token. `mcp/scripts/live-check.mjs` drives every tool against a
running stack (19 assertions) and confirms revocation stops it working.

The detail that mattered most: **a gated write returns 202 and changes nothing**, so every write
tool returns an explicit `applied` field and says "Do not report it as done" when queued. An agent
that read 202 as success would tell its user a rollout happened when it had not — worse than an
error. Writes also carry `expectedVersion`, so a conflict surfaces as a conflict.

### ~~Personal access tokens~~ · **Landed 2026-08-25**
`V7` adds `personal_access_tokens`, reusing the `sdk_keys` storage pattern (display prefix,
SHA-256, `revoked_at`) plus `expires_at` and `last_used_at`. An `sb_pat_` token resolves to the
**user** principal, so the existing RBAC applies unchanged.

**No scope column, deliberately.** A second authorization vocabulary is a second place for a
permission bug to live, and it would only ever be exercised by whoever used a token — where the
RBAC that already exists is checked on every request. To narrow a token, create a user with a
narrower role and mint it as them. Tokens are personal: somebody else's reads as 404, not 403.

### Signed webhooks · effort **S**
No general flag-change webhook exists (the AI layer has a narrow notification hook). Needs
HMAC-SHA256 signing, resource filtering, and delivery retries. Everyone has this.

---

## 5. Next — the enterprise and lifecycle cluster

### Identity and access
- **SSO/SAML + SCIM** · **M** — every vendor gates this behind a paid tier, which is what
  makes it the reliable enterprise upsell. Firebase already supports SAML/OIDC, so the
  identity half is mostly configuration; SCIM provisioning is the real work.
- **Audit export / streaming + configurable retention** · **S** — audit rows accumulate
  forever today with no export.

### Experimentation as a product · effort **M–L**
The rollout monitor hard-codes two metric keys (`error`, `conversion`). There is no metric
definition entity, no experiment object, no exposure/assignment semantics, no holdouts, no
layers or mutual exclusion, no power calculator. Warehouse-native experimentation crossed
from differentiator to table stakes during 2025–26. Start with **user-defined metric
definitions** — it is the prerequisite for everything else here and immediately makes
healing/optimizing useful beyond the two built-in signals.

### AI-era capabilities (defends the differentiator)
- **Prompt registry** · **M** — versioned prompt text with labels, diffing, restore and
  pinning. Switchboard can already gate *which* prompt an agent uses; it cannot store them.
- **LLM metrics** · **M** — tokens in/out/total, time-to-first-token, latency, and cost
  derived from declared per-million prices, plus thumbs up/down. LaunchDarkly autogenerates
  eleven such metrics. Without these, "optimize an agent rollout" cannot optimize on the
  dimension that actually matters commercially.
- **LLM-as-judge evals on sampled live traffic** · **M** · *later*

### Release workflow
- **Prerequisite flags with cycle detection** · **S–M**
- **Scheduled changes / multi-step timed rollouts** · **M** — "ramp to 50% tomorrow at 09:00".
- **Bucket-by attribute + rollout reseed** · **S** — bucket on `orgId` rather than user, and
  reseed to reshuffle a split deliberately.
- **Bulk targeting / CSV import-export** · **S–M**

### Environment management at scale · effort **M**
Environments **are** configurable — `POST /api/projects/{id}/environments` creates as many
as you like, there is no limit in the schema or the code, and `dev` / `staging` /
`production` are merely what a new project is seeded with, not a fixed set. A team that
wants ten environments can have ten today.

What breaks at that scale is everything around them:

- **Environments can only be created and listed.** There is no rename, no delete, no
  archive. One created by mistake, or one belonging to a decommissioned region, is permanent
  and will appear in every environment picker and on every flag detail page forever. This is
  incomplete CRUD on a shipped feature and the sharpest edge here.
- **Only three environments have a visual identity.** `envColors.ts` maps `dev`, `staging`
  and `production` (plus a `prod` alias); every other key falls back to neutral, so seven of
  ten environments look identical at a glance.
- **The UI assumes a handful.** Environment selection is one global `Select` in the header
  (`WorkspaceSwitchers.tsx`), but the flags list renders **one state chip per environment on
  every row** (`FlagsPage.tsx`) — at ten environments each row carries ten chips — and flag
  detail renders a left rail with one entry per environment plus an at-a-glance chip row
  (`FlagDetailPage.tsx`). Both need to collapse or filter rather than enumerate.
- **Ordering is conventional, not declared.** Environments sort by a hardcoded
  dev → staging → production preference with extras appended. There is no sort key, so a
  team with `dev`, `qa`, `uat`, `perf`, `staging-eu`, `staging-us`, `prod-eu`, `prod-us`
  gets an arbitrary order they cannot fix.
- **No cloning or templates.** Standing up environment ten means configuring every flag in
  it from scratch. "Copy configuration from production" is the obvious primitive and does
  not exist.
- **No environment classification.** Nothing marks an environment as production-like, so
  sensible defaults — require approval, disable automation bypass — must be set by hand on
  each one rather than inherited from a type.
- **Cost is linear and silent.** Creating a flag writes one config row plus one version
  snapshot per environment, and flag detail loads them all. Ten environments is ten times
  the write and payload of one, which nothing currently surfaces.

### Developer lifecycle
- **Code references scanner** · **M** — runs in the customer's CI, uploads paths and line
  numbers only. This also **materially strengthens the stale-flag sweep**, which today can
  tell you a flag stopped making a decision but not whether the code still calls it.
- **Terraform provider** · **M** — flags-as-code / GitOps.
- **CLI + local dev server with overrides** · **M** (needs PATs).
- **Evaluation explainer UI** · **M** — "why did this user get this variation", historically.
  We already return reasons and rule ids on every evaluation, so the data exists.
- **OpenTelemetry emission** (OpenFeature semconv) · **S–M**
- **Slack app** · **S–M** — approve or toggle in-channel; pairs naturally with approvals.

### More SDKs · effort **L**
OFREP already delivers Go, Python, .NET, Java and JavaScript providers with no
Switchboard-specific code. Native SDKs with local evaluation are only needed where OFREP's
remote-evaluation model is insufficient. The spec and conformance vectors mean each new
implementation has an objective acceptance bar: **pass all 474 evaluation vectors**.

**~~Java~~ · Landed 2026-08-25.** `sdk/java/` — an OpenFeature provider with local evaluation.
It changed what the next SDK costs, because most of the work was not the SDK:

- **The evaluator was extracted first** into `evaluation/`, a JDK-only module the server and the
  SDK both compile against. The Java SDK therefore contains **no evaluation logic at all** — no
  second implementation of bucketing or the sixteen operators to drift from the server's. Any
  future JVM SDK (Kotlin, Scala, Android) inherits that for free.
- **The vectors are replayed through the wire format**, not against the shared evaluator —
  running them against `FlagEvaluator` here would assert a class equals itself. All 474 go
  through `BootstrapCodec`, which is the only place a Java SDK can still disagree.
- **`LiveCheckIT` asserts local answers equal the server's** on a running stack (27 comparisons
  against the seeded environment). It found, within minutes, that the codec rejected *every real
  bootstrap payload*: a live server serialises a single-variation serve as
  `{"rollout": [], "variationId": …}` — present but empty — and every hand-written fixture
  omitted the field. No unit test written against self-invented fixtures could have caught it.

Remaining for parity with the TypeScript SDK: **telemetry** (eval/metric event batching, which
is what feeds the healing and optimizing loops) and **local persistence** of the last-known
payload. Both are additive. **S–M**

---

## 6. Operations

Most of this landed on 2026-08-25. What is left is the part that needs traffic rather than code.

- ~~**No CI.**~~ **Done.** `.github/workflows/ci.yml`: backend, dashboard, sdk, mcp, conformance,
  live and containers. The live job brings up a real stack, seeds it and runs all seven check
  scripts — including `auth-check`'s OIDC leg, which needed a second identity provider configured
  and had never actually run.
- ~~**No Dockerfiles, no deployment story.**~~ **Done.** Multi-stage images for both, a production
  compose file, and [DEPLOYMENT.md](DEPLOYMENT.md). The dashboard's configuration moved from
  build-time to runtime so one image serves any environment; `VITE_AUTH_PROVIDER` stayed a build
  argument because it decides which provider is *compiled in*, and a runtime override of it is now
  reported rather than ignored.
- ~~**Event table growth is unbounded in practice.**~~ **Configuration now**
  (`switchboard.events.retention-months`, default 3) rather than a constant, documented as
  destructive-on-lowering, and clamped at one month because the current month's partition is the
  one being written to. It still has not run against real volume — that is the part below.
- ~~**No load or performance testing.**~~ **Done 2026-08-25.** Two harnesses —
  `scripts/load-test.mjs` (request rate) and `scripts/load-volume.mjs` (data size) — and
  [PERFORMANCE.md](PERFORMANCE.md), which states the rig and the instrument's own error so the
  numbers are falsifiable rather than merely quoted. Headline: every cache-served path is
  **sub-millisecond at p50** and single-digit at p99; ≥28k eval/s sustained. Four things the
  measurement changed:
  - **The two uncached database paths are an order of magnitude slower than everything else** —
    the dashboard flag list (p99 **73.8 ms**) and telemetry ingest (p99 **62.1 ms**) against
    4–8 ms for everything served from the cache seam. That is the evidence §3's last open item
    was missing.
  - **Retention's partition-drop design is confirmed.** `DROP TABLE` on an 828k-row, 91 MB
    partition took **259 ms** and beat a row-wise `DELETE` of *less* data by 4×; the whole
    `partition-roll` job ran in 54 ms. Flat in row count, as claimed.
  - **The rollout scan is the first wall.** The aggregation costs 2.0–5.6 s *per flag* at 2.4 M
    events, and `RolloutMonitorService` iterates candidates with `concatMap` — serially. One
    rollout measured **5,884 ms**; fifty would be ~5 minutes a scan. Not user-facing (it is
    cached and backgrounded) but it arrives before anything else does.
  - **Postgres' default `work_mem` (4 MB) roughly doubles that query** by spilling a 31 MB sort
    to disk. Raising it is the cheapest performance win in the system and is a config change.

  Two honest caveats, both in the document: the throughput figure is **rig-bound, not
  server-bound** (the generator and the JVM shared 10 cores), and the rate limiter's default of
  6,000/min is **100 req/s per credential** — a single SDK key shared by a server fleet hits
  that long before it hits anything measured here.
- **No monitoring or alerting.** `/actuator/prometheus` exposes the meters; nothing scrapes them
  and no alert is defined on them. Backup/restore is documented but has never been rehearsed. **M**
- **Hosting.** The compose file is a single node by construction. The order in which that stops
  being enough is written down in [DEPLOYMENT.md](DEPLOYMENT.md#scaling-past-one-node); the first
  rung is the per-instance rate limiter. **M**

---

## 7. Deliberate non-goals

Consciously not building, so nobody re-litigates them by accident:

- **Billing and metering** — not a product concern until there are customers.
- **Multi-region / CDN edge delivery** — the Postgres `NOTIFY` fan-out is deliberately
  simple and correct; edge delivery is a different architecture and a later problem.
- **Hand-written SDKs in every language** — that is LaunchDarkly's cost structure, and they
  can afford it. OFREP plus the conformance vectors is the cheaper path to the same place.
- **Nexus dogfood integration** — a separate project, deliberately out of MVP scope.

---

## Suggested order

**Items 1–6 all landed between 2026-08-24 and 2026-08-25.** They are kept here rather than deleted
because the ordering argument is the useful part: each was placed where it was for a reason, and
the reasons held.

1. ~~**Peeking fix.**~~ **Done.** A defect in the headline differentiator; small and contained.
   Turned out to sit on a larger one — the "proportions" were denominated in evaluation *events*
   rather than subjects — which no sequential test would have fixed.
2. ~~**Bootstrap exposure + client key kinds.**~~ **Done.** A security issue the moment anyone
   used this from a browser. The same ETag bug was in the OFREP bulk endpoint and went with it.
3. ~~**Cache metrics, then the SDK-key cache.**~~ **Done.** Metrics first was the right call: the
   caching that followed was justified by hit-rate evidence rather than by reasoning.
4. ~~**Personal access tokens → MCP server.**~~ **Done.**
5. ~~**Targeting operators and typed attributes.**~~ **Done.**
6. ~~**CI and a deployment story.**~~ **Done.** The shared-cache question it was meant to force
   has an answer: not yet, and the reason is written down — the caches are read-through over
   `NOTIFY`-invalidated data, so a shared store buys nothing there. The rate limiter is the one
   thing that genuinely wants Redis, and only above one instance.

### What is actually next

7. ~~**Load and performance testing.**~~ **Done 2026-08-25** — see §6 and
   [PERFORMANCE.md](PERFORMANCE.md). Promoting it above the enterprise cluster was right for a
   reason that only showed up afterwards: it produced the evidence for item 9 below (the
   uncached dashboard list is the slowest path in the product by 10×), and it found the actual
   scaling wall — the serial rollout scan — which was not on this list at all.
8. **Signed webhooks.** The cheapest remaining thing everyone else has. **S**
9. **Approvals-adjacent enterprise cluster** (SSO/SCIM, audit export) once a buyer asks.
10. **`AiProposal` / `ChangeRequest` convergence, steps 2–3.** Deliberately deferred through the
    contract churn in the client-keys and operators work; that churn has now settled, so the
    reason for waiting is spent.
11. **Experimentation as a product**, if the market pull is real. The SRM gate built in 1 is the
    first piece of it and was not planned as such.
