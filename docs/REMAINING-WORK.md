# Remaining work

Everything not yet built, with why it matters and what it costs. Companion to
[competitive-gaps.md](competitive-gaps.md), which is the market research this is derived
from — read that for who has each feature and how the market treats it.

Effort is **S** (a day or less), **M** (a few days), **L** (a week or more), measured
against the architecture as it stands.

**Status of the product today:** backend (254 unit + 66 integration tests), web dashboard
(246), TypeScript SDK (249), mobile companion (95), an evaluation spec with 201 conformance
vectors executed by both the server and the SDK, and five live-check scripts against a
running stack. Flags, targeting, rollouts, versioning, audit, rollback, SSE delivery, the AI
layer (natural language, healing, optimizing, stale sweep), OFREP, scoped RBAC, and approval
workflows all work end to end.

---

## 1. Blocked on a decision or a credential

Nothing here is a technical problem. Each needs a human.

| Item | What is blocked | Why it matters |
|---|---|---|
| **The repo has zero commits** | Everything | Four applications, a spec, an SDK, three migrations and all documentation exist only as an uncommitted working tree on one disk. This is the highest-value, lowest-effort item on the entire list, and the only one whose downside is losing work rather than lacking a feature. Suggested shape: several coherent commits on a branch (backend foundation, AI layer, spec, SDK, dashboard, governance), not one giant one. |
| **No `ANTHROPIC_API_KEY`** | Natural-language flag creation | The Claude adapter, its forced-tool schema, and the calm `503 AI_UNAVAILABLE` degradation are all built and tested, but the real prompt-to-diff-to-apply loop **has never executed**. Everything else in the AI layer (healing, optimizing, stale sweep) works without a key. |
| **`nexus-app`'s Metro holds port 8081** | Mobile e2e | The dev client attaches to whichever bundler owns 8081 and loads *that* project's JavaScript into Switchboard's native shell, red-screening on native modules Switchboard does not ship. Resolutions: stop the competing Metro, or produce a release build where the bundler-URL fallback does not apply. See `.maestro/README.md`. |
| **Mobile app: keep or drop?** | Roadmap clarity | The web dashboard is now the primary surface. The app builds, runs, and has 95 tests, but every feature added to the product is a second implementation cost while it lives. No competitor ships a first-party mobile management app — it is a genuine differentiator, but a demo asset rather than something anyone buys on. |
| **Visual review in light and dark** | Design sign-off | Never done. Both UIs use semantic tokens only and are theme-aware by construction, but nobody has looked at the pixels. |

---

## 2. Defects in what already ships

These are not missing features. They are things Switchboard already claims to do, done
wrong or incompletely — cheaper to fix now than to explain later.

### The peeking problem — `RolloutMonitorService` · effort **S–M** · **fix first**
The healing/optimizing loop runs a **fixed-horizon two-proportion z-test (z > 3, 48h window,
min 50 samples) repeatedly on a schedule**. Repeatedly testing a fixed-horizon statistic
inflates the false-positive rate without bound as the loop runs — the textbook peeking
problem. There is also no sample-ratio-mismatch gate and no correction across the metrics
screened simultaneously.

This is the statistical core of the product's headline differentiator. It is not a
theoretical objection: LaunchDarkly publicly replaced the core of Guarded Releases with
frequentist sequential testing plus multiple-comparisons correction in January 2026 and
said false positives were the reason. Fix: an anytime-valid/sequential statistic, an SRM
gate, and a correction across screened metrics.

### Client-side exposure in the bootstrap payload · effort **M**
`GET /api/eval/bootstrap` returns the full rule set **and every segment's `includedKeys`** —
raw user identifiers. Any browser or mobile use of Switchboard today leaks the entire
targeting configuration and cohort membership to the client. There is exactly one kind of
SDK key.

Competitors all solve this and none the same way: LaunchDarkly separates SDK key / mobile
key / client-side ID and gates each flag on per-platform availability; DevCycle separates
server/client/mobile keys and adds feature obfuscation; Flagsmith makes client SDKs
remote-evaluation-only by design; ConfigCat hashes comparison values with a per-config salt
so emails never appear in the public payload. Needs: distinct key kinds, per-flag
client-side availability, and an evaluated-payload (rather than rule-set) bootstrap for
client contexts.

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

## 3. Now — what a serious buyer expects and we lack

### Richer targeting · effort **M** · highest visible deficit in a demo
Six operators (`EQUALS`, `IN`, `CONTAINS`, `STARTS_WITH`, `SEGMENT_MATCH`,
`NOT_SEGMENT_MATCH`), **no negation**, and **string-only attributes**. "Release to app
version ≥ 4.2.0 on iOS" is currently inexpressible. Every serious competitor has numeric,
date, semver and set operators; most have regex; ConfigCat has 30+ comparators.

Needs typed attributes (not `Map<String,String>`), the full operator set, and per-clause
negation. **Any change here must land as a spec change plus regenerated conformance vectors
in the same commit** — that rule is what keeps the server and every SDK in agreement.

### MCP server · effort **S** (after PATs) · table stakes, not a differentiator
LaunchDarkly (~120 tools), Statsig, ConfigCat, DevCycle, Kameleoon, Flagsmith, PostHog,
Unleash, Flipt, GrowthBook, Harness and Optimizely all ship one. Switchboard has none, and
consequently no IDE or CLI surface at all. A thin server over the existing REST API.

**Blocked on personal access tokens** (below) — an MCP server cannot authenticate with
expiring Firebase tokens.

### Personal access tokens · effort **S** · unblocks MCP and the CLI
There is no non-interactive authentication for the management API. Everything today is
either a Firebase user token (expires) or an SDK key (evaluation surface only). Needs
scoped, revocable, hashed tokens reusing the `sdk_keys` storage pattern and resolving to
the RBAC permission model already in place.

### Signed webhooks · effort **S**
No general flag-change webhook exists (the AI layer has a narrow notification hook). Needs
HMAC-SHA256 signing, resource filtering, and delivery retries. Everyone has this.

---

## 4. Next — the enterprise and lifecycle cluster

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

## 5. Operations — never started

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

## 6. Deliberate non-goals

Consciously not building, so nobody re-litigates them by accident:

- **Billing and metering** — not a product concern until there are customers.
- **Multi-region / CDN edge delivery** — the Postgres `NOTIFY` fan-out is deliberately
  simple and correct; edge delivery is a different architecture and a later problem.
- **Hand-written SDKs in every language** — that is LaunchDarkly's cost structure, and they
  can afford it. OFREP plus the conformance vectors is the cheaper path to the same place.
- **Nexus dogfood integration** — a separate project, deliberately out of MVP scope.

---

## Suggested order

1. **Commit the repo.** Nothing else matters if this is lost.
2. **Peeking fix.** A defect in the headline differentiator; small and contained.
3. **Bootstrap exposure + client key kinds.** A security issue the moment anyone uses this
   from a browser.
4. **Personal access tokens → MCP server.** Cheap, and MCP is table stakes now.
5. **Targeting operators and typed attributes.** The most visible gap in a live demo.
6. **CI and a deployment story.** The bridge from laptop to product.
7. **Approvals-adjacent enterprise cluster** (SSO/SCIM, audit export) once a buyer asks.
