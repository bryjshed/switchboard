# Remaining work

Everything not yet built, with why it matters and what it costs. Companion to
[competitive-gaps.md](competitive-gaps.md), which is the market research this is derived
from — read that for who has each feature and how the market treats it.

Effort is **S** (a day or less), **M** (a few days), **L** (a week or more), measured
against the architecture as it stands.

**Status of the product today.** Backend (336 unit + 108 integration), MCP server (7), web dashboard (329),
TypeScript SDK (249), an evaluation spec with 201 conformance vectors executed by both the server and
the SDK, and six live-check scripts against a running stack.

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
- **Flag list pagination is not wired in the dashboard** (`listFlags` returns `nextCursor`;
  the page requests 50 and stops). Invisible at nine seeded flags, breaks at real volume. **S**
- **429 is not implemented** — no rate limiter exists anywhere. OFREP documents a
  `Retry-After` path that will never fire. **S–M**
- **Dashboard ships as one 589 kB chunk** (Firebase dominates). Fine internally; route-level
  lazy loading is the fix. **S**
- **`AiProposal` / `ChangeRequest` convergence, steps 2–3.** Step 1 is done — AI applies now
  route through the approval gate. Remaining: make `ai_proposals` a *source* table and
  `change_requests` the single lifecycle for every proposed write, then collapse the status
  enums (which touches a client contract, so last). **M**

---

## 3. Caching — largely absent outside the evaluation path

One environment snapshot cache does the heavy lifting and nothing else is cached. That is
fine at demo scale and wrong at any real one.

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

### What is not cached, and where it hurts

**SDK key resolution runs a SQL join on every evaluation request.** `sdk_keys` →
`environments` → `projects`, per request, on the single hottest path in the product. At any
meaningful evaluation QPS this is the database's dominant workload, and it is pure overhead:
an SDK key's mapping to an environment changes only when a key is minted or revoked. Cache
it keyed by the key hash, invalidated on those two events. **S** · **highest-value cache
work.**

**RBAC permission resolution runs a union query per authorization decision.** Every
management request resolves permissions across org, project and environment scopes, and a
single dashboard page load makes several. Cache per `(user, scope)` with invalidation on
role-assignment change. **S–M**

**Identity lookup per authenticated request.** Every request resolves the token subject to a
user row. Same shape of fix. **S**

**JWKS fetching in the new OIDC provider.** Key sets must be cached with a sane TTL and
refreshed on an unknown `kid` — without it, every login is an outbound HTTPS round-trip to
the identity provider, and an IdP hiccup becomes a Switchboard outage. Verify this is
actually implemented rather than assumed. **S**

**Rollout statistics are aggregated from scratch every time.** The Monitor screen and every
`rollout-scan` run a `GROUP BY` across the partitioned event tables over a 48-hour window.
This is the most expensive query in the system and it is recomputed on every page load.
Needs either a short-TTL cache or incremental rollups. **M**

**No negative caching.** An unknown flag key or an invalid SDK key hits the database every
time. Besides the waste, a scanner spraying bad keys turns into unbounded database load —
this is a denial-of-service vector as much as a performance one. **S**

**Dashboard list queries** — flags, audit, change requests — are uncached. Lower stakes,
since they are human-paced. **S**

### The architecture to build toward

**Decision: go through Spring's cache abstraction, backed by Caffeine now and swappable to
Redis by configuration.** Today's `EnvSnapshotCache` is a hand-rolled Caffeine `AsyncCache`
wired directly into the service. It works, but every future cache written the same way is
another call site to rewrite the day a shared tier is needed. Adopting
`org.springframework.cache` means the provider is a config choice — `cache.provider:
caffeine | redis` — and no service code changes when it flips.

Shape it as:

- **`@EnableCaching` with a `CacheManager` chosen by property.** `CaffeineCacheManager` by
  default; `RedisCacheManager` (reactive) when configured. Declare cache names, TTLs and
  maximum sizes in `application.yml` so adding a cache is one config entry rather than new
  manager code, and freeze the name set so a typo fails loudly at startup instead of
  silently creating an unbounded cache.
- **A typed facade** over `Cache` rather than scattering `@Cacheable` string keys — a small
  `SwitchboardCache<V>` with `get`/`getOrCompute`/`put`/`evict`, obtained from a registry
  that validates the name against the configured set at bean construction.
- **Two tiers, declared per cache.** `REPLICATED` entries live in the shared store under the
  Redis provider; `LOCAL` entries stay per-instance under both providers and are invalidated
  by notification. The distinction is not premature — anything holding decrypted secrets or
  per-instance state must never leave the pod, and deciding that per cache up front is much
  cheaper than retrofitting it.

### The trap that will bite first

**`@Cacheable` on a method returning `Mono` caches the cold publisher, not the value.** Every
subsequent caller gets a publisher that re-executes on subscribe, so the cache appears to
work while doing nothing — or worse, the cached `Mono` is consumed once and later
subscribers see empty. The Caffeine manager must be configured with **async cache mode** for
`@Cacheable` to behave on reactive return types, and the current explicit
`AsyncCache` + `Mono.fromFuture` approach is correct precisely because it sidesteps this.
Whatever is adopted, prove it with a test that asserts the loader ran **once** across two
subscriptions.

Two more that follow from it:

- **Self-invocation bypasses the proxy.** `@Cacheable` methods must live in their own
  `@Component` loader bean that the service calls, not on the service itself. A private or
  same-class call goes straight past the caching advice and silently does nothing.
- **Key types must survive the invalidation channel.** Invalidation today rides Postgres
  `NOTIFY`, whose payload is text. If keys are stringified UUIDs on one side and `UUID`
  objects on the other, eviction quietly misses and instances serve stale config
  indefinitely. Pick one representation and pin it with a test.

### When Redis actually earns its place

Not yet. Caffeine is correct for a single instance, and `NOTIFY` already invalidates every
instance, so correctness does not require a shared store. Redis earns its place when there
are enough instances that cold starts hurt — a new pod today rebuilds every cache from the
database — or when something genuinely needs shared state, such as rate limiting. Both are
deployment-shaped questions, and there is no deployment yet. **Build the seam now, choose the
provider later** — that is the whole point of routing through the abstraction.

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

**The management port is unauthenticated** — the management child context does not inherit
`SecurityConfig`'s filter chain. It must be bound to the pod or host network and never
published; this needs restating in the deployment story.

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

### Richer targeting · effort **M** · highest visible deficit in a demo
Six operators (`EQUALS`, `IN`, `CONTAINS`, `STARTS_WITH`, `SEGMENT_MATCH`,
`NOT_SEGMENT_MATCH`), **no negation**, and **string-only attributes**. "Release to app
version ≥ 4.2.0 on iOS" is currently inexpressible. Every serious competitor has numeric,
date, semver and set operators; most have regex; ConfigCat has 30+ comparators.

Needs typed attributes (not `Map<String,String>`), the full operator set, and per-clause
negation. **Any change here must land as a spec change plus regenerated conformance vectors
in the same commit** — that rule is what keeps the server and every SDK in agreement.

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
implementation has an objective acceptance bar: **pass all 201 vectors**.

---

## 6. Operations — never started

None of this exists. It is what stands between "runs on a laptop" and "runs for customers".

- **No CI.** No workflows at all; every check is run by hand. **S**
- **No Dockerfiles, no deployment story, no hosting.** **M**
- **No load or performance testing.** Every latency claim in the docs is untested. Worth
  knowing: no vendor publishes p50/p95/p99 for flag delivery either. **M**
- **No monitoring, alerting, or backup/restore.** **M**
- **Event table growth is unbounded in practice** — `eval_events` and `metric_events` are
  monthly-partitioned and a partition-roll job exists, but retention has never run against
  real volume. **S**

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

1. **Peeking fix.** A defect in the headline differentiator; small and contained.
2. **Bootstrap exposure + client key kinds.** A security issue the moment anyone uses this
   from a browser.
3. **Cache metrics, then the SDK-key cache.** Every evaluation currently pays a SQL join
   for authorization; this is the cheapest large win in the system.
4. ~~**Personal access tokens → MCP server.**~~ **Done.**
5. **Targeting operators and typed attributes.** The most visible gap in a live demo.
6. **CI and a deployment story.** The bridge from laptop to product — and the point at
   which the shared-cache-tier question needs an answer.
7. **Approvals-adjacent enterprise cluster** (SSO/SCIM, audit export) once a buyer asks.
