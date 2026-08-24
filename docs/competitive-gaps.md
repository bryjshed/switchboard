# Switchboard: Competitive Gap Analysis

**Research date:** 2026-08-22
**Baseline:** Switchboard as built (Spring Boot / WebFlux / R2DBC / Postgres backend, React dashboard, Expo companion app), verified against the source tree rather than the README.
**Method:** primary vendor documentation, changelogs, OpenAPI specs, package registries, and the OpenFeature specification repo. Comparison articles were used only for orientation. Where sources conflict, the conflict is stated rather than resolved by guesswork.

---

## Executive summary

### The seven gaps that most threaten adoption

**1. No SDKs, and therefore no local evaluation.** (Known.) The specific finding worth acting on: implement **OFREP** (the OpenFeature Remote Evaluation Protocol). Two POST endpoints plus ETag/304 buys six OpenFeature-maintained providers — JS client, JS server, Go, Python, .NET, Java — for free, along with the 2026 caching, local-persistence, and SSE-notification behaviour the OpenFeature project standardised in ADRs 0008–0010. Switchboard already has bulk evaluation and an ETag-versioned bootstrap; the shape of OFREP is close to what exists. Only seven flag systems ship a native OFREP endpoint today (flagd, GO Feature Flag, Flipt, ConfigCat, DevCycle, Flipswitch, FFlags) and **none of the large commercial vendors do**, so this is cheap ground that is still open.

**2. The targeting engine is too thin to survive a bake-off.** Switchboard has **six operators** (`EQUALS`, `IN`, `CONTAINS`, `STARTS_WITH`, `SEGMENT_MATCH`, `NOT_SEGMENT_MATCH`), **no negation**, and **string-only attributes** (`EvalContext` is a `Map<String, String>`). Every serious competitor has numeric, date, semver, and set operators; most have regex. LaunchDarkly has 15 operators plus a `negate` flag; Harness FME has six type families including regex and "has all of"; ConfigCat has 30+ comparators including hashed variants; Flagsmith has regex, modulo, and semver. A buyer evaluating "release to app version >= 4.2.0 on iOS" cannot express it in Switchboard today. This is the most visible functional deficit in a live demo.

**3. There is no client-side security model.** `sdk_keys` has one kind. `GET /api/eval/bootstrap` returns the full rule set *and* every segment's `includedKeys` — i.e. raw user identifiers. Any browser or mobile use of Switchboard today leaks the entire targeting configuration and cohort membership. LaunchDarkly separates SDK key / mobile key / client-side ID and gates each flag on per-platform availability; DevCycle separates server / client / mobile keys and adds *Feature Obfuscation*; Flagsmith makes client SDKs remote-evaluation-only by design; ConfigCat hashes comparison values with a per-config salt so emails never appear in the public JSON. Switchboard has no equivalent of any of these.

**4. The governance cluster blocks every buyer above a single team.** No approvals or change requests, no RBAC beyond org-level `OWNER`/`MEMBER`, no project or environment scoping, no teams, no SSO/SAML, no SCIM, no audit export. Unleash, Flagsmith, DevCycle, PostHog, Harness FME, and LaunchDarkly all ship approvals; all gate SSO/SCIM behind a paid tier, which tells you it is the reliable enterprise upsell. The good news is in §3: Switchboard's versioned, audited, optimistically-concurrent write path is exactly the substrate an approval workflow needs, so this is cheaper here than it was for them.

**5. Experimentation is not a product.** The rollout monitor hard-codes two metric keys (`error`, `conversion`). There is no metric definition entity, no experiment object, no exposure/assignment semantics, no SRM check, no holdouts, no layers or mutual exclusion, no power calculator. Warehouse-native experimentation crossed from differentiator to table-stakes during 2025–26 — LaunchDarkly's June 2026 expansion to BigQuery, Databricks, and Redshift is the marker. Switchboard is not on the board.

**6. The statistical core of Switchboard's own differentiator is below the 2026 bar.** `RolloutMonitorService` runs a **fixed-horizon two-proportion z-test (z > 3.0, 48h window, min 50 samples) repeatedly on a schedule**. That is the textbook peeking problem: the realised false-positive rate grows without bound as the loop runs. This is not a theoretical objection — **LaunchDarkly publicly replaced the Bayesian core of Guarded Releases with frequentist sequential testing (GAVI: Howard 2021, Waudby-Smith et al. 2024) plus multiple-comparisons correction in January 2026, and said the reason was false positives.** Switchboard also has no SRM gate and no correction across the metrics it screens. Fixing this is small, contained work with disproportionate credibility payoff.

**7. The developer lifecycle story is missing.** No code references scanner, no flags-as-code / GitOps, no Terraform provider, no CLI, no IDE extension, and **no MCP server**. MCP is now table-stakes, not a differentiator: LaunchDarkly (~120 tools), Statsig (50+), ConfigCat (50+), DevCycle (35+), Kameleoon (40+), Flagsmith, PostHog, Unleash, Flipt, GrowthBook, Harness, and Optimizely all ship one. Separately, the stale-flag sweep is materially weaker than it looks *because* there is no code-reference data: it can tell you a flag stopped making a decision, but not whether the code still calls it. LaunchDarkly, ConfigCat, Flagsmith, and DevCycle all combine both signals.

### Where Switchboard is genuinely ahead

Stated as precisely as the research supports, and with the counterweight attached.

**Automated rollback and ramp, ungated.** Switchboard ships opt-in auto-rollback and auto-ramp for every org. In the market, this capability exists at LaunchDarkly (**Enterprise plus the separately-priced Guardian add-on**), Statsig (Safeguards, evaluated **every 24 hours** on Cloud), Harness (Continuous Verification, which is unsupervised ML over time series, not a hypothesis test on flag traffic), and Datadog. Unleash has auto-pause and auto-disable-environment but **not** graduated rollback to a prior milestone. Flagsmith, ConfigCat, DevCycle, Flipt, GO Feature Flag, and PostHog have nothing — PostHog's absence of auto-rollback is its clearest gap. So: the capability is genuinely rare below the enterprise tier, and Switchboard's decision latency beats Statsig Cloud's by orders of magnitude. The counterweight is gap 6 — a fast loop makes peeking worse, which is precisely why LaunchDarkly's fast implementation had to go sequential.

**In-product natural language to a typed, reviewable diff.** Across every vendor surveyed, **nobody ships an in-console "describe your targeting rule in English" box.** The universal pattern is agent-delegated: an MCP server plus (at LaunchDarkly) published agent skills. Switchboard's forced-tool-use proposal — one tool schema, output validated into a `FlagChangeDiff`, applied through the same audited write path a human edit takes — is a different and defensible shape: it works for a non-developer in the dashboard, and it produces an artifact a reviewer can approve. The counterweight is that the *outcome* is reachable via MCP at a dozen vendors, and Switchboard has no MCP server at all, so it loses the IDE and CLI surface entirely.

**Every write is a version, and concurrency is honest.** Each `FlagEnvConfig` write bumps a monotonic version, appends an immutable snapshot, writes an audit row, and advances the environment `stateVersion` in one transaction; rollback writes a *new* version copying an old snapshot rather than rewriting history; and `expectedVersion` returns **409** on a stale write. Version history is common; **optimistic concurrency on flag configuration is not** — it does not appear in any surveyed vendor's public contract. Flagsmith's equivalent (Feature Versioning v2) is opt-in **and irreversible once enabled**, and breaks its own legacy endpoints. ConfigCat has version history but **no approvals at all**, still in development as of May 2026.

**Streaming for everyone.** SSE change delivery with `Last-Event-ID` catch-up, fanned out across instances via Postgres `NOTIFY`, at no tier. Compare: **Flagsmith's real-time SSE is Enterprise-only** and its payload is just a timestamp ping (the SDK must re-fetch); **Unleash streaming is beta and Enterprise Edge only**, and OSS Unleash Edge is **EOL 2026-12-31**; **ConfigCat's cloud cannot push at all** — "realtime" means webhook to your endpoint, then you call `forceRefresh()`, with true SSE available only from the self-hosted Proxy. Switchboard's `patch`-per-change is also better than Flagsmith's re-fetch ping. Getting this from one Postgres instead of a Redis/Kafka tier is a real operational advantage for a self-hoster.

**Safety defaults that competitors document as footguns.** Unknown flag returns the caller's default with reason `SDK_DEFAULT` at HTTP 200, never a 5xx; evaluation reasons are on the public API from day one and map cleanly onto OpenFeature's reason enum; bucketing salts on the flag key so ramps are sticky and decorrelated across flags; `BUCKET_SPACE` is 10,000, leaving headroom for 0.01% steps. That last one is worth naming: **flagd cannot express a 0.1% canary today** — its fractional operator is capped at 100 buckets, and the fix is still a draft ADR.

**A mobile kill switch.** No surveyed competitor ships a first-party mobile management app. Be honest about its weight: this is a demo asset and an on-call convenience, not a line item anyone buys on.

**The honest caveat over all of it:** most of these advantages are currently unreachable, because without SDKs nothing here is wired into a real application. Gap 1 is what converts the list above from architecture into product.

---

## Detailed findings

### 1. Targeting and segmentation

**What Switchboard has:** single context (`key` + `Map<String,String>` attributes); six operators; ordered rules with AND-ed clauses; individual targets; project-scoped segments with included keys, excluded keys, and rules; deterministic sticky percentage rollout.

| Capability | Switchboard | Who has it | Why a buyer cares | Effort |
|---|---|---|---|---|
| Typed attributes (number, bool, date, semver, JSON, array) | ✗ strings only | LaunchDarkly (bool/number/string/array/JSON, dates as RFC3339 or epoch ms), Harness FME, ConfigCat, Flagsmith, Unleash, Flipt, DevCycle | "Roll out to app version >= 4.2.0", "users created after March", "accounts over 500 seats" are the first three rules anyone writes | **M** |
| Numeric / date / semver / regex operators | ✗ | LaunchDarkly (15 ops incl. `matches` regex, `semVer*`, `before`/`after`), Harness FME (regex, semver, set ops, DateTime), ConfigCat, Flagsmith (regex, modulo, semver), Unleash (`NUM_*`, `DATE_*`, `SEMVER_*`), Flipt (datetime, number) | Same as above; regex in particular is a common migration blocker | **M** (with the above) |
| Negation on any clause | ✗ (only `NOT_SEGMENT_MATCH`) | LaunchDarkly (`negate` boolean per clause), Unleash (all operators negatable), ConfigCat, Harness FME | "everyone except internal domains" is a daily need | **S** |
| Multi-context / context kinds | ✗ | LaunchDarkly (`kind: multi`, context instances, per-kind private attributes); PostHog group targeting | B2B targeting — a rule about the *organization* and the *user* at once; also the randomization unit for org-level experiments | **L** |
| Prerequisite flags / dependencies | ✗ | LaunchDarkly (AND-ed, cycle-blocked, dependent flags listed on the parent), Harness FME (`is in flag`, one impression), ConfigCat (same Config only), Unleash (Enterprise, **single-level only**), PostHog (thinly documented). **Absent: Flagsmith, Flipt, GO Feature Flag, DevCycle** | Gating a feature behind its parent release without duplicating rules | **S–M** |
| Bucket-by attribute (`bucketBy`) | ✗ (always context key) | LaunchDarkly (string/integer attributes only), GO Feature Flag (`bucketingKey`), DevCycle (Custom Property Randomization), ConfigCat (configurable percentage attribute) | Cohort-level rollouts — bucket a whole org or region together, not per user | **S** |
| Reshuffle / rollout seed | ✗ (hash is `flagKey:contextKey`, fixed) | Harness FME (Murmur3 with a per-flag-per-environment seed + a **Reallocate Traffic API**, 2026-04-14) | Re-randomising for a second experiment on the same flag without inheriting the first assignment | **S** |
| Scheduled / temporal targeting changes | ✗ | DevCycle (**best in class** — gradual and multi-step rollouts with per-milestone dates), PostHog (incl. recurring), Harness FME (`scheduledFor` on change requests), Flagsmith, LaunchDarkly (**in maintenance mode, planned for deprecation** — superseded by progressive rollouts). **Absent: ConfigCat** | "Ship at 9am Monday" without someone being awake | **M** |
| Bulk targeting / CSV import | ✗ | LaunchDarkly (Add/Remove/Replace, 1,500 per task; CSV import 40MB / 1M contexts), Harness FME (large segments, 1M IDs) | Migrating an existing allowlist | **S–M** |
| Large cohorts / big segments | ✗ (segments load fully into `EnvSnapshot`) | LaunchDarkly (>15,000 targets → Redis or DynamoDB, requires Relay Proxy or a persistent store integration; cached lookup 1–10ms), Harness FME (1M IDs — **but server-side SDKs cannot use them; flags targeting one return `control`**), Flagsmith (DynamoDB Global Tables), Statsig (ID Lists — **>1,000 entries are not synced to the Vercel edge**) | Any allowlist beyond a few thousand users blows up the bootstrap payload | **L** |
| Nested segments | ✗ (explicitly rejected in the evaluator) | LaunchDarkly (same environment, cycle-checked) | Composing cohorts | **S** |
| Synced / external cohorts | ✗ | LaunchDarkly only — 8 sources: Amplitude, Fivetran, Heap, Hightouch, RudderStack, Tealium, Twilio Segment, Zeotap; ~30s sync | Targeting a cohort computed in the CDP | **L** |
| Mutual exclusion between experiments | ✗ | LaunchDarkly (layers with per-experiment reservations), Statsig, Eppo, GrowthBook (namespaces). Harness FME documents it as a **pattern that "scales poorly"**, not a feature. **Absent: everyone else** | Running two experiments on the same surface without contaminating both | **L** |

**Where the field is weaker than you'd assume:** flag dependencies are missing from Flagsmith, Flipt, GO Feature Flag, and DevCycle. Nested segments are essentially LaunchDarkly-only. Mutual exclusion is genuinely rare. Prioritise operators and types over the exotic items.

**Architectural note on effort.** Typed attributes are an **M**, not an **S**, because the change reaches further than it looks: `EvalContext.attributes`, `Clause.values`, the JSONB round-trip for `TargetingConfig` (see the known hazard around records with derived JSON properties), the OpenAPI contract, the dashboard rule builder, the AI tool schema in `FlagChangeToolSchema`, and — most importantly — the cross-language evaluation contract. **`spec/conformance/` is currently an empty directory** while `FlagEvaluator`'s javadoc and the README both assert that a spec exists and governs changes. Write the spec *before* the operator work, not after; the operator set is the thing the spec is mostly about, and every SDK will encode it.

---

### 2. Experimentation and measurement

**What Switchboard has:** `eval_events` and `metric_events` in monthly-partitioned tables with BRIN indexes; a rollout monitor computing a two-proportion z-test on `error` and `conversion` against the highest-traffic variation; `rollout-stats` per flag/environment.

That is a monitoring loop, not an experimentation product. The distinction matters commercially: a buyer comparing "experimentation" will be holding a checklist built from LaunchDarkly, Statsig, Eppo, and GrowthBook.

| Capability | Switchboard | Who has it | Why a buyer cares | Effort |
|---|---|---|---|---|
| User-defined metrics | ✗ (`error` / `conversion` hard-coded) | All of LaunchDarkly (9 types + metric groups + funnels), Harness FME (5 types, **retroactive** — define after the fact and backfill), PostHog (funnel/mean/ratio/retention with HogQL), DevCycle (4), Flagsmith (4, Enterprise beta) | You cannot measure a business without naming its metrics | **M** |
| Experiment as a first-class object | ✗ | LaunchDarkly, PostHog, Harness FME, Statsig, DevCycle, Flagsmith. **Absent: ConfigCat (structurally — its SDKs evaluate locally and it receives no telemetry), Unleash, Flipt, GO Feature Flag** | Start/stop, results, history, sharing | **L** |
| Sequential / anytime-valid testing | ✗ (fixed-horizon z, evaluated repeatedly) | **Table-stakes, 7 of 9 surveyed.** Two lineages: mSPRT (Optimizely, Statsig, Amplitude) and confidence sequences (Eppo, GrowthBook, Kameleoon, **LaunchDarkly**). Harness FME uses mSPRT for its sequential mode; PostHog implements always-valid p-values per Waudby-Smith 2023 | Without it, a monitoring loop that peeks continuously has an unbounded false-positive rate | **S–M** |
| Sample ratio mismatch (SRM) check | ✗ | LaunchDarkly (**auto-rollback fires on SRM regardless of the metric setting**), Statsig (χ² plus a *time series* of the SRM p-value), Eppo (χ² at α=0.001), Optimizely (**sequential SRM** — anytime-valid on the diagnostic itself), PostHog, Harness FME, GrowthBook | A skewed split invalidates every number above it. It is the cheapest guard against acting on garbage | **S** |
| Multiple-comparisons correction | ✗ | LaunchDarkly (across treatments / metrics / both), Harness FME (Benjamini–Hochberg, **opt-in, off by default**), Optimizely (tiered BH), Eppo (**preferential Bonferroni** — primary power invariant to how many other metrics you attach), Kameleoon (Holm–Šidák), Statsig. **PostHog applies none by default** | Screening several metrics per rollout multiplies false alarms | **S** |
| Guardrail metrics | ✗ (implicitly, `error`) | LaunchDarkly (org-level defaults auto-attached since 2025-08-07), Harness FME (account-wide alerting), Eppo | Named, reusable "do not regress this" set | **S** |
| CUPED / variance reduction | ✗ | LaunchDarkly (ANCOVA, 7-day lookback, mean metrics only), PostHog (opt-in, project default), Statsig (**7 days before that user's own exposure**, not a calendar window), **Eppo CUPED++** (ridge per variation over *all* eligible metrics plus assignment properties — works on retention metrics and brand-new users). **Absent: Harness FME, DevCycle, ConfigCat** | 36–49% shorter experiments at 60–70% pre-period correlation (LaunchDarkly's published figure) | **L** |
| Holdouts | ✗ | LaunchDarkly (1–5% recommended), PostHog (1–10%, variant `holdout-{id}`), Statsig (**auto-added to every new feature**, 1–2% over 3–6 months), GrowthBook (5/5/90 asymmetric split). **Absent: Harness FME, DevCycle, ConfigCat** | Measuring cumulative impact of everything shipped | **M** |
| Power / sample-size calculator | ✗ | LaunchDarkly (fixed-horizon calculator + in-results estimator), PostHog (`N = 16·variance/d²`, MDE default 30%), Harness FME (thin), GrowthBook (**sequential-aware**) | "How long will this take?" is asked before every experiment | **S** |
| Exposure / assignment semantics | ~ (`eval_events` exist, semantics undefined) | LaunchDarkly (flag evaluation *is* the exposure; 90-day correlation window; Exposures tab with 30-day retention), PostHog (`$feature_flag_called`; **`getAllFlags()` records no exposure and silently excludes those users**), Harness FME (impressions with OPTIMIZED/DEBUG/NONE modes) | Without defined exposure, metric attribution is arbitrary | **M** |
| Warehouse-native | ✗ | **Newly table-stakes.** Harness FME (GA 2026-04-08; Snowflake/Redshift/BigQuery), LaunchDarkly (Snowflake 2025 → +BigQuery/Databricks/Redshift 2026-06-25), Statsig WHN (widest: +Athena, Synapse, S3), Eppo, GrowthBook (OSS). PostHog has warehouse *metrics*, not warehouse-native — PostHog stays the engine | Data governance: PII never leaves the buyer's warehouse; no per-event pricing | **L** |
| Bandits | ✗ | LaunchDarkly (Thompson sampling, Monte Carlo win probabilities), Statsig Autotune (Thompson; **LinUCB contextual**, hourly retrain), Optimizely (**CMAB GA 2026-04-28**), Kameleoon (epsilon-decreasing), GrowthBook | Auto-optimising among many variants | **L** |

**Two openings the research identified as genuinely unclaimed.** First, **valid inference after adaptive allocation** — only Optimizely (Epoch Stats Engine, a stratified estimator computed within constant-allocation epochs to defeat Simpson's paradox) and GrowthBook document a fix at all. This is directly relevant to Switchboard, whose auto-ramp *changes allocation mid-flight* and then keeps measuring across the change, which is exactly the bias in question. Second, **automated A/A monitoring** — no vendor sells continuously-running A/A checks. Eppo's pre-experiment-data diagnostic is functionally one but is not marketed as such.

**Recommended sequence, and it is cheap.** Replace `TwoProportionZ` with an asymptotic confidence sequence (Waudby-Smith et al. 2023 is the most-cited and is what PostHog, GrowthBook, and LaunchDarkly converged on), add an SRM gate before any finding is filed, and apply a correction across the metric set being screened. `RolloutMonitorService` already has the window, the minimum-sample floor, the dedup key, and the threshold constant — the shape is right, the statistic is wrong. This is the highest credibility-per-line-of-code change available, and it defends the product's headline claim.

---

### 3. Release workflow and governance

**What Switchboard has:** immutable version snapshots, full audit log, one-click rollback, `expectedVersion` optimistic concurrency (409), kill switch, org roles `OWNER`/`MEMBER`, Firebase auth.

| Capability | Switchboard | Who has it | Why a buyer cares | Effort |
|---|---|---|---|---|
| Approvals / change requests | ✗ | Unleash (Enterprise, **up to 10 approvers**; note **no built-in role has the permission** — you must author a custom role), Flagsmith (Scale-Up+; feature CRs and segment CRs; **identity overrides bypass entirely**), DevCycle (Enterprise; locks the form; **self-targeting and metric changes bypass**), PostHog (Enterprise), Harness FME (diff view, object locked, **plus OPA/Rego policy-as-code**), LaunchDarkly (1–5 required approvals, per-environment, tag-scoped, bypass action for incidents). **Absent: ConfigCat (in development), Flipt (delegates to Git PRs), GO Feature Flag (Git PRs)** | Nobody lets an intern flip production alone | **M** |
| Required comment / reason on change | ✗ | ConfigCat ("mandatory notes", environment-level, lands in the audit "Why" column, extended to deletion 2026-06-04), LaunchDarkly (required comments and required confirmation — **both UI-only, not enforced via the API**) | Audit trails that explain intent, not just diff | **S** |
| Four-eyes / self-approval block | ✗ | LaunchDarkly ("Requesters can review their own request" toggle), Unleash. **DevCycle does not document one** | SOX-style separation of duties | **S** (with approvals) |
| Scheduled changes | ✗ | See §1 | | **M** |
| Progressive / staged rollouts | ~ (AI-drafted ramp steps) | LaunchDarkly (progressive rollouts on all tiers; **guarded** rollouts Enterprise+Guardian), DevCycle (gradual + multi-step, best documented), Unleash (release templates with milestones + metric safeguards, GA v8.0) | Ramping without a human in the loop each step | **S** |
| Environment promotion | ✗ | DevCycle (copy targeting rules between environments), Unleash (environment cloning, Enterprise), Flagsmith (release pipelines, closed beta), LaunchDarkly (**release pipelines — beta, select Enterprise customers, boolean flags only**), ConfigCat (copy values / clone flag). ⚠️ Harness FME has no confirmable first-class UI feature | "It works in staging, ship the same config" | **M** |
| RBAC beyond owner/member | ✗ | LaunchDarkly (Reader/Writer/Admin/Owner + preset project/org roles + custom roles as JSON policy + **role attributes** for parameterised scoping + views), Unleash (custom project roles v4.6, custom root roles v5.4), Flagsmith (Scale-Up+, custom roles unlimited, **tagged permissions**), DevCycle (three tiers, full RBAC Enterprise-only), PostHog (org/project/resource, **effective level is the highest granted from any source** — permissions stack up, they do not intersect), Harness FME | The first thing a 30-person eng org asks for | **M** |
| Teams / groups | ✗ | LaunchDarkly (+ IdP group sync via SCIM), Unleash (groups with SSO sync), Flagsmith. **ConfigCat has no team entity** — permission groups only | Assigning ownership at scale | **M** |
| SSO / SAML | ✗ (Firebase email/password) | Enterprise-gated almost everywhere: LaunchDarkly (SAML 2.0; **no OIDC**; one IdP per account), Unleash (SAML + OIDC), Flagsmith, DevCycle, PostHog (SAML at Scale $750/mo), Harness FME (**SAML Strict Mode enforced**). ConfigCat notably ships **SAML and SCIM on all plans including Free**; Flipt ships SSO free | Procurement gate. No SSO, no enterprise deal | **M** (Firebase supports SAML/OIDC) |
| SCIM provisioning | ✗ | LaunchDarkly (Enterprise, OAuth2, Okta + OneLogin; ⚠️ team sync documented as Okta-only on one page and Okta+OneLogin on another), Unleash (v6.1+, Okta/Entra), Flagsmith (**does not support the `active` attribute** for deactivation), PostHog (Enterprise), ConfigCat (**all plans, since 2025-05-21**) | Deprovisioning on offboarding | **M** |
| Audit export / streaming | ✗ (query API only) | LaunchDarkly (audit log subscriptions to Splunk HEC, Datadog Events, "dozens of tools", scoped by role policy), Flagsmith (audit-log webhooks, HMAC-SHA256), Harness FME (audit-log webhooks) | SIEM ingestion is a compliance requirement | **S** |
| Audit retention policy | ✗ (unbounded) | LaunchDarkly (Developer 30d, Foundation 30d for account changes, unlimited Enterprise), ConfigCat (7/35/35/750/750 days by plan), Unleash (90d PAYG, 2y Enterprise), PostHog (7d Boost → 60 months Enterprise) | Both a compliance floor and a cost lever | **S** |

**The structural advantage worth exploiting.** Approvals are usually expensive because a vendor has to retrofit a staging concept onto a mutable config. Switchboard already writes every change as an immutable snapshot with a monotonic version and rejects stale writes with a 409. A change request is close to "a proposed snapshot that has not been promoted to head" — and `AiProposal` already models a reviewable pending change with `APPLY`/`REJECT` transitions through `ProposalService`. Generalising `AiProposal` into a human change-request type is materially cheaper than building it from nothing, and it would make AI proposals and human proposals the same object, which is the right design anyway.

**A cautionary note from the field:** every vendor that shipped approvals also shipped bypass holes, and they are all documented. Flagsmith's identity overrides bypass change requests. DevCycle's self-targeting and metric edits bypass. LaunchDarkly's adaptive triggers bypass approval workflows entirely. Switchboard's equivalent hazard is the auto-rollback path — if approvals land, decide deliberately whether the healing loop is inside or outside the gate, and document it. Skipping the gate during an incident is defensible; skipping it silently is not.

---

### 4. Delivery and runtime

**What Switchboard has:** REST evaluation (single + bulk), ETag/304 bootstrap, SSE with `put`/`patch`/`ping` and `Last-Event-ID`, Postgres `NOTIFY` fan-out, per-environment hashed revocable SDK keys.

| Capability | Switchboard | Who has it | Why a buyer cares | Effort |
|---|---|---|---|---|
| Local (in-process) evaluation | ✗ | Everyone. Harness FME, LaunchDarkly, Unleash, Flagsmith, ConfigCat, DevCycle (**shared WASM bucketing library** across Cloudflare Workers and server SDKs), Flipt (**shared Rust core via FFI and WASM**, 10 languages), PostHog (8 languages), GO Feature Flag | Zero network latency on the hot path; survives vendor outages; attributes never leave the process | **L** (known) |
| OFREP endpoint | ✗ | flagd, GO Feature Flag, Flipt, ConfigCat (via Proxy), DevCycle, Flipswitch, FFlags. **No large commercial vendor** | Six maintained OpenFeature providers for free, plus standardised caching and SSE-notification behaviour | **S** ← highest leverage in this document |
| Client-side / mobile key kinds | ✗ (one kind) | LaunchDarkly (SDK key / mobile key / client-side ID; **multiple keys per environment with names, expirations, and per-key RBAC since 2026-05-12**), DevCycle (server / client / mobile, rotated independently), Harness FME (server key → full segments; client key → **only segments containing that key**) | Without it, browser and mobile use leaks your rule set and cohorts | **M** |
| Per-flag client-side availability | ✗ | LaunchDarkly (flags marked available on mobile / client-side SDKs) | Keeps unreleased flag names out of shipped bundles | **S** |
| Secure mode / request signing | ✗ | LaunchDarkly (HMAC-SHA256 of the canonical `kind:key` under the server SDK key) | Stops a browser client from evaluating as someone else | **S** |
| Payload obfuscation | ✗ | DevCycle (Feature Obfuscation — hashes variable keys via CLI; **JS/React/Next.js only**), ConfigCat (comparison values **SHA-256 hashed with a per-config salt**, so raw emails never appear in the public JSON) | Unreleased feature names are competitive information | **M** |
| Relay / proxy / daemon | ✗ | LaunchDarkly Relay (proxy / daemon / offline; ~20,000 concurrent connections per m4.xlarge), Unleash Edge (**Rust; 600 RPS @ 0.1 vCPU → 40,000 @ 8 vCPU; ~1 vCPU per 5,000 RPS**), Flagsmith Edge Proxy (~2,000 RPS @ ~7ms mean; **Rust rewrite is 6–11× faster**), ConfigCat Proxy (**most feature-complete: CDN mode, eval API, OFREP, SSE, gRPC, Redis/Mongo/DynamoDB**), Statsig Forward Proxy (Rust, gRPC bidi streaming), Harness (six optional components), flagd-proxy | Air-gap, connection fan-in, egress control | **M–L** |
| Edge / CDN delivery | ✗ | LaunchDarkly Flag Delivery Network (Fastly Compute, 100+ PoPs) + edge SDKs for Cloudflare/Vercel/Akamai/Fastly, DevCycle (Cloudflare CDN + Workers, **~1s global invalidation**), Flagsmith Edge API (Lambda + DynamoDB Global Tables, 8 regions), ConfigCat (Cloudflare), Unleash hosted Edge (16–17 DCs) | Global p99 | **L** (known) |
| Offline / bootstrap-from-file | ✗ | LaunchDarkly (Relay offline mode; SSR bootstrap via `allFlagsState`), Unleash Edge offline mode, Flagsmith Offline Mode + CLI-generated `environment.json`, Flipt (`getSnapshot()` → you persist the blob), GO Feature Flag (`persistentFlagConfigurationFile`) | Air-gapped and disaster scenarios | **S–M** |
| Published SLA | ✗ | Unleash **99.99% on any annual subscription** (least-gated in the field), ConfigCat **99.99/99.95/99.9/99% by tier including a 99% SLA on Free**, LaunchDarkly 99.99% (**Premium Support only**; Enterprise Support gets 99.9% with **no credits** — termination and refund only), Flagsmith 99.95% qualified as "**commercially reasonable efforts**". **Statsig publishes none** | Procurement checkbox | **S** (as a doc) |
| Published latency targets | ✗ | LaunchDarkly is the only flag vendor publishing numeric targets, and only on its pricing page: **<300ms SLO (Developer) / <200ms SLO (Foundation) / <150ms SLA (Enterprise)** | Table-stakes claim in an RFP | **S** |

**Two findings worth internalising.**

*No feature-flag vendor publishes p50/p95/p99 for its delivery path.* Every number in the market is a marketing average ("25ms init" — traced to a **2021** LaunchDarkly blog), a laptop benchmark (Flagsmith's ~7ms is on an M1 MacBook), or an adjective ("sub-millisecond"). The only genuine percentile anywhere in the survey is **Vercel Global Config: 15ms P99, with linked methodology** — and that is the substrate, not the flags. **Publishing a real percentile with a stated method would be a differentiator no incumbent currently holds.** It costs a load test and an honest paragraph.

*2026 is the year of delta and resumable protocols.* LaunchDarkly's FDv2 went GA 2026-05-15 (two-phase init, data-saving resume). OpenFeature added SSE change-notification (ADR-0008, 2026-02-20), local-storage persistence keyed on ETag (ADR-0009, 2026-03-06), and **killed default timer polling** (ADR-0010, 2026-03-19). Unleash has a Delta API in beta. Switchboard's `patch`-per-change SSE plus ETag bootstrap is already on the right side of this trend — which is another argument for OFREP, since OFREP is now the only open, vendor-neutral specification of exactly this pattern.

**Also relevant to the roadmap:** the relay tier has standardised on **Rust** — Unleash Edge, Statsig Forward Proxy, and Flagsmith's `edge-proxy-rs` (6–11× the Python original on identical hardware). If Switchboard builds a relay, that is the precedent, and it is a separate artifact from the Java control plane.

---

### 5. Developer experience and lifecycle

**What Switchboard has:** OpenAPI contract as source of truth; evaluation reasons on the public API; stale-flag sweep with generated retirement checklists; seed and smoke scripts.

| Capability | Switchboard | Who has it | Why a buyer cares | Effort |
|---|---|---|---|---|
| Code references scanning | ✗ | LaunchDarkly `ld-find-code-refs` (Go, OSS, runs in *your* CI so source never leaves; extinction events; aliases; monorepo support), ConfigCat (**three-tier detection: direct, aliases at a 30%+ similarity threshold, wrappers**; finds deleted flags from the past 180 days), Flagsmith (**GitHub only**; uploads paths and line numbers only), DevCycle (GitHub + GitLab, per-PR flag insights). **Absent: Unleash, Flipt, GO Feature Flag, Harness FME (no standalone scanner), PostHog (VS Code extension only)** | It is the missing half of stale-flag detection | **M** |
| Stale-flag detection | ✓ (usage + settled-state) | LaunchDarkly (lifecycle stages + four archive checks), ConfigCat (Zombie Flags, configurable, stale-in-all vs stale-in-any), DevCycle (**most precisely specified**: Unmodified 14d/30d by type, Released 14d at 100%, Unused 2 weeks; daily at midnight UTC), Unleash (lifecycle stages + per-type expected lifetimes + technical-debt rating), Flagsmith (**requires Feature Versioning enabled**), PostHog (30d) | Flag debt is the #1 complaint about flags | — |
| AI-generated cleanup PRs | ✗ (checklist only) | LaunchDarkly **Vega** (Claude-powered; **GitHub only**; scheduled automated cleanup 1/7/30 days, 1–20 jobs per run; reads root `CLAUDE.md`/`AGENTS.md`; PRs titled `[Vega]`), Harness FME (**beta, requires an Anthropic API key**; NL selection criteria → `ff_eligible.json` → human approval → PR), PostHog (VS Code AST-based removal preserving the correct code path) | Closing the loop from "this is stale" to "it is gone" | **M–L** |
| MCP server | ✗ | **Table-stakes.** LaunchDarkly (~120 tools, hosted OAuth; **not on EU or Federal**), ConfigCat (50+, stdio only), DevCycle (35+), Kameleoon (40+), Statsig (50+ incl. an approve/reject/commit workflow), Flagsmith (hosted, **early access**, OAuth *and* API key — the cleanest unattended-CI story), PostHog (incl. **historical-timestamp flag evaluation testing**), Unleash (Enterprise for remote), Flipt, GrowthBook, Harness, Optimizely | Where flag authoring is actually happening in 2026 | **S** |
| Terraform provider | ✗ | LaunchDarkly (**v3.0.0 GA 2026-07-21**, Plugin Framework rebuild, 8 new resources; v2 maintained in parallel), Harness (`harness/harness`), ConfigCat (`configcat/configcat`, since 2020), Flagsmith (v0.10.0), Unleash (**explicitly cannot manage feature flags** — only tokens, projects, environments, roles), DevCycle. **Absent: Flipt (one community provider, 499 downloads), GO Feature Flag**. ⚠️ PostHog unconfirmed | Platform teams will not adopt what they cannot codify | **M** |
| CLI | ✗ (scripts only) | LaunchDarkly `ldcli` (v3.10.0, fast cadence, includes `dev-server`), ConfigCat, Flagsmith (**Go rewrite v2.0.0, 2026-08-21**, OIDC-first CI auth), DevCycle, Flipt, GO Feature Flag (`evaluate` / `lint` / `generate`) | Scripting and CI | **M** |
| Flags-as-code / GitOps | ✗ | Flipt v2 (**Git is the storage backend — reads *and writes*; branches; merge proposals open real PRs**), GO Feature Flag (YAML/JSON/TOML + 12 retrievers), Featurevisor. **LaunchDarkly has no flag-manifest product** — its three sanctioned paths are Terraform, the REST API, and the offline relay file | A large and vocal developer constituency | **L** |
| Local dev / override tooling | ✗ | LaunchDarkly (`ldcli dev-server` on :8765 with `add-override`; test data sources), ConfigCat (Flag Overrides from file, map, or **query string**), DevCycle (Self-Targeting per environment), Flipt (local file backend) | Testing without touching a shared environment | **S–M** |
| Evaluation reasons | **✓** | LaunchDarkly (`OFF`, `FALLTHROUGH`, `TARGET_MATCH`, `RULE_MATCH` + ruleId, `PREREQUISITE_FAILED`, `ERROR` + errorKind, `inExperiment`), Flipt, ConfigCat (`getValueDetails`), OpenFeature standard. **Flagsmith has no reason field at all** | Answering "why did this user get B?" | — |
| Evaluation explainer / debugger UI | ✗ | LaunchDarkly **Live events** (rebuilt 2026-08-10: time ranges, payload-size and misconfigured-key diagnostics, **evaluation reason clickable through to the rule that produced it**), DevCycle **Evaluation Lookup** (historical, per user, with reason) + point-in-time simulation, Unleash Playground (per-clause true/false), PostHog MCP (**evaluate a flag as of a historical timestamp, with person properties as they were then** — the strongest debugging primitive found), ConfigCat (Info-level log prints the evaluation process). ⚠️ Harness FME's key page **cannot validate attribute rules because Harness never receives attribute values** | Support and debugging | **M** |

**The honest read on the stale-flag sweep.** Switchboard's version is well-designed for what it can see: a flag that has not been edited past the org threshold *and* has stopped making a decision. But every competitor that takes flag debt seriously combines that with code references, and the two signals answer different questions. LaunchDarkly's archive checks require *absence of code references*; ConfigCat's zombie report links to them; DevCycle's "Unused" state uses evaluation data the way Switchboard does but pairs it with GitHub/GitLab flag insights. Without code references, Switchboard can generate a retirement checklist it cannot verify, and the checklist is the part a user has to trust.

**MCP is the cheapest item in this table and the most visible.** Switchboard's REST API is already the complete surface — both UIs are pure consumers of it, which is exactly the property that makes an MCP wrapper thin. It also composes with the existing NL proposal work rather than competing with it: MCP for the IDE, the in-product proposal for the dashboard.

---

### 6. Integrations and ecosystem

**What Switchboard has:** one org-level notification webhook, fired only for monitor findings, best-effort with errors swallowed.

| Capability | Switchboard | Who has it | Why a buyer cares | Effort |
|---|---|---|---|---|
| General flag-change webhooks | ✗ (monitor findings only) | Everyone. LaunchDarkly (HMAC-SHA256 in `X-LD-Signature`, **policy-language filter** on which resources fire), Flagsmith (three kinds — environment, organisation, audit-log — all HMAC-SHA256), ConfigCat (templated with `##ChangeNotes##` etc., HMAC-SHA256 with a secondary key for rotation, 5 retries), Unleash, GO Feature Flag | The universal escape hatch | **S** |
| Slack | ✗ | LaunchDarkly (**approve/deny/comment in-channel**, toggle targeting from Slack, `/launchdarkly`, "notify me when a flag is ready to remove"), Flagsmith (OAuth, per-environment channels), ConfigCat, Unleash, DevCycle, PostHog, Harness FME | Where flag changes are actually discussed | **S–M** |
| Microsoft Teams | ✗ | LaunchDarkly (link unfurling; ⚠️ **AI config and segment approvals do not flow to Teams**), ConfigCat, Unleash, GO Feature Flag. ⚠️ **Flagsmith's Teams integration does not exist** — it is a "coming soon" placeholder in the dashboard plus a marketing-site claim, with no docs page and no backend module | Enterprise chat parity | **S–M** |
| Jira / Linear | ✗ | LaunchDarkly (**Jira Connect → Forge migration mandatory for pre-March-2026 setups**), Flagsmith (Marketplace app, **SaaS-only**), ConfigCat, Unleash (Jira Cloud only, no Server/DC), DevCycle. **No vendor surveyed ships a Linear integration** | Linking a flag to the work item | **M** |
| GitHub / GitLab | ✗ | DevCycle (**Flag Code Usages + Flag Change Insights per PR/MR**), Flagsmith (two-way, flags inside issues and PRs), LaunchDarkly (Actions, code refs, Vega PRs), Harness FME (cleanup PRs; ⚠️ **GitHub is absent from its integrations directory**) | Flag state visible at review time | **M** |
| Datadog / Sentry / New Relic | ✗ | LaunchDarkly (**bidirectional**: change events *and* triggers — an APM alert can toggle a flag; ⚠️ the **Datadog dashboard widget is deprecated**, Datadog retired UI extensions 2025-03-31; **Sentry runs the other way — Sentry errors become LD metrics** usable in experiments and guarded rollouts), Flagsmith (Datadog events + RUM, New Relic, Dynatrace, AppDynamics, Grafana annotations + **Feature Health**), Unleash (Datadog **events not metrics**), ConfigCat (Datadog; ⚠️ **no Sentry, no New Relic**), DevCycle (**Dynatrace, first-party post-acquisition**) | "Which release caused this error spike?" | **M** |
| OpenTelemetry | ✗ | **The strongest common denominator.** Flipt (all three signals, OTel semantic conventions), GO Feature Flag (traces + an OTel exporter), Flagsmith (self-hosted, W3C TraceContext + SQL commenter), Unleash (Edge OTLP exporter), DevCycle (spans named `feature_flag_evaluation.{key}`), LaunchDarkly (hooks + native OTLP ingest). OpenFeature ships an **observability appendix pinned to OTel semconv** | One integration that satisfies many | **S–M** |
| Analytics / CDP | ✗ | ConfigCat (Amplitude — **including sending evaluation data to Amplitude Experiments** — Mixpanel, GA, Segment, Datadog; this is how a vendor with *no* experimentation engine still offers A/B), Flagsmith (Segment, Amplitude, Mixpanel, Heap, RudderStack, Adobe — all via forwarding identity evaluations; **these do not run in local-evaluation mode**), LaunchDarkly (Segment three ways). ⚠️ **Mixpanel has no LaunchDarkly integration** — it appears only as a subprocessor | Cohort analysis without a warehouse | **M** |
| Data export / event streams | ✗ | LaunchDarkly (streaming to Kinesis/Event Hubs/Pub/Sub/mParticle/Segment; warehouse export to BigQuery/ClickHouse/Databricks/Redshift/S3/Snowflake; **no backfill — export starts from activation**), Harness FME (10M impression rows per export, 5 exports/day, **90-day availability, 7-day file retention**), PostHog (batch exports + managed warehouse), DevCycle (**Snowflake data sharing**). **Absent: ConfigCat entirely — no warehouse connector of any kind** | Owning your own evaluation data | **M** |

**The cheapest credible first move is a general signed webhook plus OpenTelemetry.** A single signed flag-change webhook unlocks Slack, Teams, Datadog, and every homegrown consumer through one contract — which is precisely how Unleash and GO Feature Flag cover breadth without building fifty integrations. OTel is the second, because it satisfies Datadog, New Relic, Honeycomb, Grafana, and Dynatrace at once, and because OpenFeature has already standardised the semantic conventions for flag evaluation spans.

---

### 7. Data and compliance

**What Switchboard has:** hashed SDK keys, per-environment isolation, org isolation proven in the seed data, monthly-partitioned event tables with a partition-roll job.

| Capability | Switchboard | Who has it | Why a buyer cares | Effort |
|---|---|---|---|---|
| Private / redacted attributes | ✗ | LaunchDarkly (`allAttributesPrivate` / `privateAttributes`; per-context-kind and **sub-attribute paths** like `/address/street`; ⚠️ a designation is **sticky** for the life of the context instance even after removal). ConfigCat and DevCycle solve it architecturally — user data never reaches the vendor | GDPR minimisation; security review | **M** |
| PII posture | ⚠️ attributes are stored server-side and reach `eval_events` | ConfigCat and Unleash-with-Edge: **evaluation is local, so context never reaches the vendor**. Flagsmith is the cautionary case — traits are persisted per identity and **the trait-write API is unauthenticated by design**, so its own docs warn you must use unguessable GUIDs and disable trait persistence if segments drive authorisation | Determines whether a security review passes | — |
| Anonymous context handling | ✗ | LaunchDarkly (`anonymous: true`, excluded from the contexts list, **but still billed as MAU**) | Cost and privacy | **S** |
| Data residency | ✗ | ConfigCat (**per-product Global vs EU Only**; an SDK mismatch degrades to higher latency rather than failing), LaunchDarkly (**EU instance in Frankfurt** — net-new Enterprise only, with a long unsupported-feature list including observability and the hosted MCP server; plus a **FedRAMP Federal instance** on `launchdarkly.us`), PostHog (US and EU Cloud), Flagsmith (Edge in 8 regions, **Core API is EU-hosted in London**), DevCycle ("customisable, contact support"). ⚠️ **Harness FME appears not to offer EU residency** (medium confidence) | EU deals stop here | **L** |
| SOC 2 Type II | ✗ | LaunchDarkly, Unleash, Flagsmith, DevCycle, PostHog (report through 2025-05-31), Harness (**an FME-specific report**). ⚠️ **ConfigCat is NOT SOC 2 certified** — it holds ISO 27001:2022 instead. **Flipt has zero compliance claims** — `flipt.io/security` and `/trust` both 404 | Enterprise procurement gate | **L** (audit, not code) |
| ISO 27001 | ✗ | ConfigCat (27001:2022), Harness (+27017, 27018), LaunchDarkly (+27701). ⚠️ Unleash documents **control mappings, not a certificate**. Not claimed by DevCycle or PostHog | EU procurement | **L** |
| HIPAA / BAA | ✗ | LaunchDarkly (BAA required; **PHI permitted only in context objects and targeting rules — no safeguards elsewhere**), PostHog (**BAA from the Boost tier, $250/mo** — unusually cheap). ⚠️ Not confirmed for Harness, ConfigCat, DevCycle | Healthcare | **L** |
| FedRAMP | ✗ | LaunchDarkly only (**Moderate ATO**, `launchdarkly.us`, FIPS 140-3, a heavily restricted integration list, and **no AgentControl and no observability**) | US public sector | **Won't** |
| Self-hosting / air-gap | ~ (it is your code) | ConfigCat (three distinct things: Proxy ≠ Hosted Dedicated ≠ true On-Premise), Flagsmith (Docker/K8s/Helm/OpenShift; EE images add Oracle and MySQL), Unleash, Flipt (**self-host-only — Flipt Cloud shut down 2025-08-29**), GO Feature Flag (MIT, no vendor at all), LaunchDarkly (**none** — the closest is Relay offline mode). ⚠️ **PostHog sunset Kubernetes/Helm support in May 2023**; only an unsupported Docker Compose "Hobby" deployment remains | Regulated and cost-sensitive buyers | **M** (as a supported artifact) |
| Retention controls | ~ (4-month partition roll) | LaunchDarkly (30-day contexts, 30-day exposures, tiered AI-data retention, 60-day playground data), ConfigCat (7–750 days audit by plan), PostHog (7 days → 60 months) | Compliance floor and cost ceiling | **S** |

**One licensing shift to watch, because three of four OSS vendors changed terms in 15 months.** Unleash relicensed **Apache-2.0 → AGPL-3.0** (merged 2026-05-26, shipped in v8.0.0; official OSS Docker images remain Apache-2.0). Flipt v2 moved to **FCL-1.0-MIT** (Fair Core: source-available, non-compete, each version converting to MIT two years after release), while v1 stays GPL-3.0. Flagsmith is **BSD-3-Clause and was never BSL** — its commercial gating is a closed-source `flagsmith-private` package plus private EE images, with much enterprise-adjacent code sitting in the public repo behind a licence check. GO Feature Flag remains MIT. If Switchboard ever open-sources, this is the live precedent set.

---

### 8. AI-era capabilities

This is Switchboard's differentiator, so the assessment needs to be sharper than elsewhere: where is it genuinely ahead, and where does the market have something it does not.

**The rename you need to know:** LaunchDarkly's **AI Configs is now AgentControl** (May 2026). The docs, the platform pillars (CodeControl / AgentControl), and the marketing all moved; the REST paths (`/ai-configs/`), the OpenAPI tag, the SDK identifiers, and the EU docs instance still say AI Configs. Anything written before mid-2026 uses the old name.

#### What "AI Configs" actually means at each vendor

| Vendor | Product | What it does | Status |
|---|---|---|---|
| **LaunchDarkly** | **AgentControl** | Prompts, model selection, inference params, and tools pulled out of code and served through the *same targeting engine as flags*. Completion mode (`messages`) and Agent mode (`instructions` + tools/skills/judges). Versioned variations with JSON+text diff and non-destructive restore. **Prompt snippets** (`{{snippet.key#version}}`, version-pinned). **Tools library**. **Agent graphs** (nodes = agent configs, edges = handoffs; auto-orchestration for LangGraph and the OpenAI Agents SDK). **Judges** — 3 built-ins (Accuracy, Relevance, Toxicity) plus custom rubrics, scoring 0.0–1.0. **Online evals** on sampled live traffic; **offline evals** against CSV/JSONL datasets; **Playgrounds**. **Agent Optimization** rewrites instructions against acceptance criteria. **Adaptive triggers** auto-swap a variation on error or accuracy degradation. 11 auto-generated metrics (tokens in/out/total, TTFT, duration, success/error, thumbs up/down) that are **ordinary LD metrics** — usable as experiment goals, guardrails, and bandit targets | GA (AI Configs GA 2025-05-28); Optimization public beta 2026-07-29 |
| **Harness FME** | **AI Config Management** | Built on "Harness Configs", a runtime config layer inside FME. Prompts, model selection, inference params, routing, fallback messages; **same rule builder as flags**; impression data feeds FME experiments so you can A/B two prompts or two models; RBAC, approvals, OPA policy checks, version history, rollback. **Uses the existing Configs SDK — no separate AI SDK** | ⚠️ **Announced 2026-07-21 with a blog post and marketing page and ZERO documentation pages.** Not in release notes through 2026-08-18. Treat as announced, not proven |
| **PostHog** | **Prompt management** | Prompts created and edited in PostHog, fetched at runtime by SDK (Python, JS/TS) with caching and fallback. **Every edit is an immutable version**; labels (e.g. "production") point at versions, so **saving is decoupled from releasing**. Explicitly wired to experiments: "compare prompt versions on cost, latency, and eval pass rate." Paired with **LLM analytics** capturing prompt, response, tokens, cost, latency, and tools; ingests forwarded traces from Helicone, Langfuse, Traceloop, Keywords AI | ⚠️ No GA badge and no locatable GA date |
| **Statsig** | **AI Experimentation** | Versioned prompt configs with four version types and distinct SDK visibility — **Draft** (hidden), **Candidate** (served to SDK but hidden from users, i.e. shadow-run), **Live**, **Archive**. Offline evals with four grader types (LLM-judge, string comparison, text similarity, **Python**), one Primary and optional Critical graders. Online evals grade sampled live traffic from OTel traces your app emits | ⚠️ **Early Access.** `docs.statsig.com/llms.txt` states verbatim "AI Experimentation is Early Access and is not accepting new customers" — a sentence appearing **only** in the agent-facing file and contradicting Amplitude's public "GA in a couple of months" |
| **Flagsmith** | — | Marketing-level only: "system prompts, model identifiers, and inference parameters can all be managed as flag values." **No prompt registry, no versioning primitive.** The LangWatch partnership puts prompt versioning in **LangWatch**, not Flagsmith | Not a product |
| **ConfigCat, DevCycle, Unleash, Flipt, GO Feature Flag, GrowthBook, Optimizely, Amplitude, Kameleoon, AB Tasty** | — | No AI config equivalent | — |
| **Datadog (ex-Eppo)** | Prompt Tracking | Versions prompts as first-class artifacts with per-version cost and performance and text diffs — **but does not serve prompts to your app**, and the Feature Flags GA release does not tie flags to prompts. Custom LLM-as-a-judge evaluations **are GA** | Partial |

#### Where Switchboard stands

**Ahead:**

- **Automated rollback and ramp, ungated, on a per-org opt-in, applied through the audited write path.** In the market this is Enterprise-plus-add-on (LaunchDarkly Guardian) or 24-hour-cadence (Statsig Cloud) or absent. Switchboard's version is also *uniform*: the same loop covers ordinary flags and agent-prompt flags, because the agent run is just a context.
- **Agent gating as a natural consequence of the model.** Using the run id as the context key and describing the run in attributes makes a prompt revision or a tool a multivariate flag with no new primitive. LaunchDarkly needed a whole second product (agent mode, tools library, agent graphs) to reach the equivalent. Switchboard's version is thinner but it is *free* — and, notably, Switchboard's `agent-planner-prompt` seed flag demonstrates it working.
- **In-product NL → typed diff → human review.** Discussed in the executive summary; nobody else ships the in-console form.

**Behind, and specifically:**

- **No prompt registry.** Switchboard can serve a prompt *variant label*; it cannot store, version, diff, or restore prompt text. LaunchDarkly has prompt snippets with version pinning; PostHog has immutable versions with label-based release; Statsig has four version states including shadow-run candidates. This is the single largest AI-side gap, and it is the one a buyer will name first, because "we keep prompts in the flag value as a string" is what every competitor's *worst* answer already sounds like.
- **No LLM-specific metrics.** Switchboard measures `error` and `conversion`. The field measures input/output/total tokens, **time to first token**, cost, latency, thumbs up/down, and judge scores. Cost in particular is what makes token-aware rollouts possible at all, and LaunchDarkly builds it from manually-entered per-million prices — a cheap approach worth copying.
- **No judges or evals.** Built-in and custom LLM-as-judge scoring is now common (LaunchDarkly, Statsig, Harness AI Evals, Datadog, Langfuse, Braintrust, LangSmith). Switchboard has an LLM in the loop for *authoring* but not for *measuring*.
- **No model routing or fallback.** Neither does LaunchDarkly, to be fair — **AgentControl does not proxy or make LLM calls**; there is no gateway, no key vaulting, no network-layer failover. Routing lives in the gateway tier: OpenRouter (price-weighted load balancing by inverse square of price, `sort` by price/throughput/latency, `max_price`, Auto Router over ~30 task types), LiteLLM (explicit cost-based routing), Portkey, Helicone, Vercel AI Gateway. **This is a deliberate non-goal, not a gap** — see below.
- **No MCP server**, covered in §5.

**The clean line worth holding onto.** The LLMOps tier (Langfuse, LangSmith, Braintrust, PromptLayer) versions prompts and can split traffic, but **essentially none of them run production A/B experiments with statistical analysis and automatic rollout decisions**. Langfuse's "experiments" are offline dataset runs — no significance testing, no winner declaration; its production A/B guidance is literally an app-side `random.choice()` and "compare metrics in the UI". PromptLayer has percentage splits and segment targeting but no significance testing and no auto-rollback. **That is exactly the gap Switchboard's healing loop sits in** — a prompt platform that decides. It is a real and defensible position, and it is why gap 6 (statistical validity) is not a nice-to-have: the position depends entirely on the decision being trustworthy.

---

## Prioritised roadmap

| Gap | Who has it | Buyer impact | Effort | Priority |
|---|---|---|---|---|
| **OFREP endpoints (`/ofrep/v1/evaluate/flags[/{key}]`) + ETag/304** | flagd, GO Feature Flag, Flipt, ConfigCat, DevCycle | **High** | **S** | **Now** |
| **Sequential/anytime-valid statistic + SRM gate + multiple-comparison correction in the rollout monitor** | LaunchDarkly (GAVI, Jan 2026), Statsig, Eppo, GrowthBook, PostHog | **High** | **S–M** | **Now** |
| ~~Write the evaluation spec + conformance vectors~~ **DONE 2026-08-22** — `spec/evaluation.md` (normative) + 201 vectors in `spec/conformance/`, executed by the Java reference (202 tests) and by the TypeScript SDK (205); MD5 bucketing replaced `String.hashCode` for cross-language portability | flagd (JSON schema + published bucketing algorithm), Flipt (CUE) | **High** | **S** | **Done** |
| Typed attributes + full operator set (numeric, date, semver, regex, ends_with, exists) + per-clause negation | Everyone | **High** | **M** | **Now** |
| Client-side / mobile key kinds + per-flag client-side availability + evaluated-payload bootstrap | LaunchDarkly, DevCycle, Harness FME | **High** | **M** | **Now** |
| General signed flag-change webhook (HMAC-SHA256, resource-filtered) | Everyone | **High** | **S** | **Now** |
| MCP server over the existing REST API | Table-stakes — 12+ vendors | **High** | **S** | **Now** |
| Approvals / change requests (generalise `AiProposal` into a human change-request type) | Unleash, Flagsmith, DevCycle, PostHog, Harness FME, LaunchDarkly | **High** | **M** | **Next** |
| RBAC: project/environment scoping + custom roles | LaunchDarkly, Unleash, Flagsmith, PostHog | **High** | **M** | **Next** |
| SSO/SAML + SCIM (Firebase already supports SAML/OIDC) | All; ConfigCat ships both on Free | **High** | **M** | **Next** |
| User-defined metric definitions (replace hard-coded `error`/`conversion`) | LaunchDarkly, Harness FME, PostHog, DevCycle, Flagsmith | **High** | **M** | **Next** |
| Prompt registry: versioned prompt text, labels, diff, restore, pinning | LaunchDarkly (snippets), PostHog, Statsig | **High** | **M** | **Next** |
| LLM metrics: tokens in/out/total, TTFT, latency, cost from declared per-million prices, thumbs up/down | LaunchDarkly (11 autogen metrics), PostHog | **High** | **M** | **Next** |
| Prerequisite flags with cycle detection | LaunchDarkly, Harness FME, ConfigCat, Unleash, PostHog | Med | **S–M** | **Next** |
| Scheduled changes / multi-step timed rollouts | DevCycle, PostHog, Harness FME, Flagsmith | Med | **M** | **Next** |
| Code references scanner (runs in the customer's CI; upload paths and line numbers only) | LaunchDarkly, ConfigCat, Flagsmith, DevCycle | **High** | **M** | **Next** |
| Terraform provider | LaunchDarkly, Harness, ConfigCat, Flagsmith, DevCycle | **High** | **M** | **Next** |
| Bucket-by attribute + rollout reseed | GO Feature Flag, DevCycle, ConfigCat; Harness FME (reseed API) | Med | **S** | **Next** |
| Audit export / streaming + configurable retention | LaunchDarkly, Flagsmith, Harness FME | Med | **S** | **Next** |
| OpenTelemetry emission (OpenFeature semconv) | Flipt, GO Feature Flag, DevCycle, LaunchDarkly, Flagsmith | Med | **S–M** | **Next** |
| Evaluation explainer UI (why this context got this variation, historical) | LaunchDarkly Live events, DevCycle Evaluation Lookup, PostHog MCP, Unleash Playground | Med | **M** | **Next** |
| Bulk targeting / CSV import-export | LaunchDarkly, Harness FME | Med | **S–M** | **Next** |
| CLI + local dev server with overrides | LaunchDarkly `ldcli`, Flagsmith, ConfigCat, DevCycle | Med | **M** | **Next** |
| Slack app (approve/toggle in-channel) | LaunchDarkly, Flagsmith, ConfigCat, Unleash | Med | **S–M** | **Next** |
| Native SDKs with local evaluation (after the spec, and beyond OFREP's reach) | Everyone | **High** | **L** | **Next** |
| Judges / LLM-as-judge evals on sampled live traffic | LaunchDarkly, Statsig, Harness AI Evals, Datadog | Med | **M** | **Later** |
| Experiment as a first-class object (start/stop, results, history) | LaunchDarkly, PostHog, Harness FME, Statsig | **High** | **L** | **Later** |
| Holdouts | LaunchDarkly, PostHog, Statsig, GrowthBook | Med | **M** | **Later** |
| Nested segments | LaunchDarkly | Low | **S** | **Later** |
| Relay proxy / daemon (Rust; air-gap + connection fan-in) | LaunchDarkly, Unleash, Flagsmith, ConfigCat, Statsig | Med | **M–L** | **Later** |
| Multi-context / context kinds | LaunchDarkly | Med | **L** | **Later** |
| Large-cohort segments backed by an external store | LaunchDarkly, Harness FME, Flagsmith | Med | **L** | **Later** |
| Environment promotion (copy config across environments) | DevCycle, Unleash, Flagsmith, LaunchDarkly | Med | **M** | **Later** |
| Published latency percentiles + an SLA document | **Nobody publishes percentiles** — LaunchDarkly publishes SLO/SLA targets only | Med | **S** | **Later** |
| Data residency (EU) | ConfigCat, LaunchDarkly, PostHog, Flagsmith | **High** for EU | **L** | **Later** |
| SOC 2 Type II | LaunchDarkly, Unleash, Flagsmith, DevCycle, PostHog, Harness | **High** for enterprise | **L** | **Later** |
| CUPED / variance reduction | LaunchDarkly, PostHog, Statsig, Eppo | Med | **L** | **Later** |
| Warehouse-native experimentation | Harness FME, LaunchDarkly, Statsig, Eppo, GrowthBook | Med | **L** | **Later** |
| Mutual exclusion layers | LaunchDarkly, Statsig, Eppo, GrowthBook | Low–Med | **L** | **Later** |
| Synced cohorts from CDPs | LaunchDarkly only | Low | **L** | **Later** |
| AI-generated cleanup PRs | LaunchDarkly Vega, Harness FME (beta) | Med | **M–L** | **Later** |
| Edge / CDN delivery | LaunchDarkly, DevCycle, Flagsmith, ConfigCat, Unleash | Med | **L** | **Later** |
| Session replay / product analytics / observability suite | LaunchDarkly (via Highlight.io), PostHog | Low | **L** | **Won't** |
| LLM gateway: model routing, fallback, key vaulting, cost-based routing | OpenRouter, LiteLLM, Portkey, Helicone, Vercel AI Gateway. **Not LaunchDarkly** | Low | **L** | **Won't** |
| FedRAMP / Federal instance | LaunchDarkly only | Low | **L** | **Won't** |
| Flags-as-code with Git as the storage backend | Flipt v2, GO Feature Flag | Low | **L** | **Won't** |
| Contextual bandits | Statsig, Optimizely, Kameleoon, GrowthBook | Low | **L** | **Won't** |

---

## Deliberate non-goals

**1. An LLM gateway.** Do not proxy model calls, vault provider keys, or do network-layer routing and failover. LaunchDarkly explicitly does not — AgentControl returns resolved config and your app makes the call. That tier is crowded and commoditised (OpenRouter charges no inference markup; Vercel AI Gateway is zero-markup including BYOK), it puts Switchboard on the latency-critical path of every model call, and it drags in provider-credential custody with all the security surface that implies. Serve the *decision*; let the gateway serve the request.

**2. Session replay, error monitoring, and a product-analytics suite.** LaunchDarkly bought Highlight.io in April 2025 and took until January 2026 to GA the result; PostHog got there by being an analytics company first. Both are multi-year platform bets. Integrate with Datadog, Sentry, and OTel instead — that is what every other flag vendor does, and it is what buyers expect.

**3. Warehouse-native experimentation.** It is now table-stakes *in the experimentation tier*, and it is genuinely expensive: a SQL compilation layer per engine, a metric definition language, and orchestration inside someone else's warehouse. It also presupposes item 2 on the Next list (metric definitions) and a real experiment object. Revisit only if enterprise deals start dying on data residency, which is the actual reason buyers ask for it.

**4. FedRAMP.** LaunchDarkly is the only vendor with an ATO, and the cost is visible in what it had to give up: no AgentControl, no observability, no hosted MCP, a fixed integration allowlist, and FIPS-compiled binaries. Do not start this without a signed public-sector customer.

**5. Git-as-storage flags-as-code.** Flipt v2 rebuilt its entire storage layer around it and dropped relational databases, `import`/`export`, and OCI bundles to get there; GO Feature Flag has no admin UI worth the name as a consequence. It is a coherent product identity, but it is a *different* product from one whose core is an audited, versioned, concurrently-safe database write path with an AI loop on top. A Terraform provider gets most of the IaC benefit at a fraction of the cost.

**6. Contextual bandits.** Statsig's LinUCB with hourly retraining, Kameleoon's neural approach (which discloses that it runs with no exploration bonus), Optimizely's CMAB. High implementation and explanation cost, narrow demand, and it compounds the adaptive-allocation inference problem Switchboard already has unsolved. Fix the sequential statistic first.

**7. A separate mobile-management product.** Keep the companion app as the kill switch it is. No vendor competes here and no buyer chooses on it. Do not spend roadmap on making it a full dashboard.

**8. Per-seat pricing.** Not a feature gap, but the pricing research points one way for a product at this stage: ConfigCat (flat per plan, seats and MAU unlimited, metered on CDN egress), PostHog (per flag request, seats free), DevCycle (MAU-based, seats unlimited), and Statsig (no per-seat at any tier) have all moved off seats. Harness is moving the *other* way — toward billing "active users" including view-only — and it is a documented customer complaint. Seat-based pricing punishes exactly the read-only stakeholders whose adoption you want.

---

## Sources

**OpenFeature and the standard**
- OpenFeature specification releases (v0.9.0, tagged 2026-07-24) — https://github.com/open-feature/spec/releases
- OpenFeature specification sections and stability badges — https://github.com/open-feature/spec/tree/main/specification
- OFREP protocol and OpenAPI 0.3.0 — https://github.com/open-feature/protocol (service/openapi.yaml; ADR-0005, ADR-0008, ADR-0009, ADR-0010)
- CNCF project status (Incubating since 2023-11-21) — https://www.cncf.io/projects/openfeature/
- OpenFeature provider and OFREP-API datasets — https://github.com/open-feature/openfeature.dev/tree/main/src/datasets
- flagd releases, sync configuration, providers spec, fractional operation spec, high-precision bucketing ADR — https://github.com/open-feature/flagd · https://flagd.dev/schema/v0/flags.json
- OpenFeature governance board 2026–2028 — https://openfeature.dev/blog/governance-board-2026/

**LaunchDarkly**
- Docs root (docs.launchdarkly.com 301s here) — https://launchdarkly.com/docs · machine index https://launchdarkly.com/docs/llms.txt
- Contexts, multi-contexts, context instances — /docs/home/flags/contexts/intro, /multi-contexts, /context-instances
- Flag evaluation rules (the 15 operators) — /docs/sdk/concepts/flag-evaluation-rules
- Segment types (the 15,000 boundary), segment config, big segments — /docs/home/flags/segment-types, /segment-config, /docs/sdk/features/big-segments
- Prerequisites, bulk targeting, scheduled changes (maintenance mode) — /docs/home/flags/prereqs, /bulk-targeting, /docs/home/releases/scheduled-changes
- Guarded rollouts, regression detection, frequentist methodology (GAVI) — /docs/home/releases/guarded-rollouts, /regression-detection, /docs/guides/statistical-methodology/methodology-frequentist
- Sequential testing in Guarded Releases (2026-01-29) — https://launchdarkly.com/changelog/sequential-testing-guarded-releases/
- CUPED — /docs/guides/experimentation/cuped · Holdouts — /docs/home/holdouts · Layers — /docs/home/experimentation/mutually-exclusive
- Warehouse-native — /docs/home/warehouse-native/warehouses · Multi-armed bandits — /docs/home/multi-armed-bandits
- Approvals and config — /docs/home/releases/approvals, /approval-config · Roles — /docs/home/account/roles/role-concepts
- SSO, SAML, SCIM — /docs/home/account/sso, /saml, /scim · Change history — /docs/home/releases/change-history
- Keys and multiple SDK key support (2026-05-12) — /docs/home/account/environment/keys · https://launchdarkly.com/changelog/multiple-sdk/
- Relay Proxy — /docs/sdk/relay-proxy (+ /use-cases, /enterprise, /offline, /automatic-configuration) · https://github.com/launchdarkly/ld-relay
- Edge SDKs — /docs/sdk/edge · FDv2 GA — https://launchdarkly.com/changelog/fdv2-flag-delivery-v2-server-side-protocol/
- Code references — /docs/home/flags/code-references · https://github.com/launchdarkly/ld-find-code-refs
- Vega and flag cleanup — /docs/home/getting-started/vega, /docs/home/flags/manage/flag-cleanup-vega
- MCP (hosted and local) — /docs/home/getting-started/mcp-hosted, /mcp-local · Agent skills — https://github.com/launchdarkly/agent-skills
- Terraform provider v3 — /docs/integrations/terraform (+ /migration-2-to-3)
- AgentControl — /docs/home/agentcontrol (+ /agents, /judges, /online-evaluations, /offline-evaluations, /playground, /snippets, /tools, /agent-graphs, /triggers, /optimization, /monitor, /insights, /experimentation, /privacy)
- AI SDKs and the handler-architecture migration — /docs/sdk/ai, /docs/sdk/ai/migration · Auto-generated AI metrics — /docs/home/metrics/autogen/ai
- Private attributes — /docs/home/flags/private-context-attributes · EU and Federal instances — /docs/home/infrastructure/eu, /federal
- Pricing and billing — https://launchdarkly.com/pricing · /docs/home/account/calculating-billing
- SLA — https://launchdarkly.com/policies/service-level-agreement/ · Status — https://status.launchdarkly.com/
- Highlight.io acquisition (2025-04-23) — https://launchdarkly.com/blog/welcome-highlight-to-launchdarkly/

**Unleash**
- Activation strategies and operators — https://docs.getunleash.io/concepts/activation-strategies · Unleash context — /reference/unleash-context
- Resource limits — /reference/resource-limits · Feature flag lifecycle — /concepts/feature-flags
- Impact metrics (beta v7.5, GA v8.0) — /concepts/impact-metrics · Unleash Edge — /unleash-edge (+ /deploy)
- OpenFeature providers (beta v8.1) — /sdks/openfeature · Availability and support tiers — /support/availability
- AGPL relicense PR #12086 — https://github.com/Unleash/unleash/pull/12086 · LICENSE — https://github.com/Unleash/unleash/blob/main/LICENSE
- Pricing — https://www.getunleash.io/pricing · SLA — https://www.getunleash.io/sla

**Flagsmith**
- Segment rule operators — https://docs.flagsmith.com/flagsmith-concepts/segments/segment-rule-operators
- Experimentation (Enterprise beta, Bayesian) — https://docs.flagsmith.com/experimentation/
- Change requests — /administration-and-security/governance-and-compliance/change-requests · Code references — /managing-flags/code-references
- Edge API — /performance/edge-api · System limits — /system-administration/system-limits
- LICENSE.md (BSD-3-Clause) — https://github.com/Flagsmith/flagsmith/blob/main/LICENSE.md
- Rust edge proxy benchmarks — https://github.com/Flagsmith/edge-proxy-rs · Edge API economics — https://www.flagsmith.com/blog/flagsmith-edge-api-sdk-v2
- Pricing — https://www.flagsmith.com/pricing · SLA — https://www.flagsmith.com/service-level-agreement

**Flipt**
- v2 introduction (Git-native storage) — https://docs.flipt.io/v2/introduction · Merge proposals — /v2/guides/user/environments/merge-proposals
- Targeting schema (CUE) — https://github.com/flipt-io/flipt/blob/v2/core/validation/flipt.cue
- v2 LICENSE (FCL-1.0-MIT) — https://github.com/flipt-io/flipt/blob/v2/LICENSE
- Flipt Cloud sunset (2025-07-24, terminated 2025-08-29) — https://blog.flipt.io/sunsetting-flipt-cloud
- Client SDKs (shared Rust core, FFI + WASM) — https://github.com/flipt-io/flipt-client-sdks · Pricing — https://www.flipt.io/pricing

**GO Feature Flag**
- Targeting — https://gofeatureflag.org/docs/configure_flag/target-with-flags · Rollout strategies — /rollout-strategies
- Custom bucketing — /custom-bucketing · Flag sets — /docs/concepts/flagset · Relay proxy — /docs/relay-proxy
- Tracking API (OpenFeature Tracking spec) — /docs/tracking/tracking-api · OpenFeature positioning — /product/open-feature
- LICENSE (MIT) — https://github.com/thomaspoignant/go-feature-flag/blob/main/LICENSE

**Harness FME (formerly Split)**
- Docs root — https://developer.harness.io/docs/feature-management-experimentation/ · Release notes — /release-notes/feature-management-experimentation/
- Custom attribute matchers — /feature-management/targeting/target-with-custom-attributes
- Statistical approach (Welch's t-test, mSPRT, BH) — /docs/feature-management-experimentation/statistical-approach
- Warehouse-native (GA 2026-04-08) — /warehouse-native/ · Mutually exclusive experiments — /experimentation/setup/mutually-exclusive-experiments
- Automated flag cleanup (beta) — /templates · Release Agent — /release-agent/
- AI Config Management announcement (2026-07-21) — https://www.harness.io/blog/announcing-ai-config-management
- AI Evals (beta) — https://www.harness.io/products/ai-evals · Trust — https://trust.harness.io/

**ConfigCat**
- User conditions and comparators — https://configcat.com/docs/targeting/targeting-rule/user-condition/ · Flag conditions — /flag-condition/
- Zombie flags — https://configcat.com/docs/zombie-flags/ · Code references — /advanced/code-references/overview/
- Proxy — https://configcat.com/docs/advanced/proxy/overview/ · Data governance — /advanced/data-governance/
- MCP server (2025-09-30) — https://configcat.com/docs/advanced/mcp-server/ · News feed — https://configcat.com/docs/news/
- Pricing — https://configcat.com/pricing/ · Plan limits — https://configcat.com/docs/subscription-plan-limits/ · SLA — https://configcat.com/sla/ · Trust — https://configcat.com/trust-center/

**DevCycle (Dynatrace)**
- Targeting overview — https://docs.devcycle.com/platform/feature-flags/targeting/targeting-overview · Rollouts — /rollouts
- How metrics are calculated — /platform/experimentation/how-metrics-are-calculated
- Approval workflows — /platform/security-and-guardrails/approval-workflows · Permissions — /permissions
- Architecture (Cloudflare + WASM) — /essentials/architecture/ · EdgeDB — /platform/feature-flags/targeting/edgedb
- Keys — /platform/account-management/keys · Feature obfuscation — /platform/security-and-guardrails/feature-obfuscation
- Stale feature notifications — /platform/feature-flags/stale-feature-notifications · Evaluation lookup — /platform/testing-and-qa/debug-tools/evaluation-lookup
- CLI and MCP — https://docs.devcycle.com/cli-mcp/ · Dynatrace integration — /integrations/dynatrace
- Dynatrace acquisition (2026-01-13) — https://www.dynatrace.com/news/blog/dynatrace-acquires-devcycle-to-strengthen-feature-delivery/ · https://blog.devcycle.com/devcycle-is-now-part-of-dynatrace/
- Pricing — https://devcycle.com/pricing · Security — https://devcycle.com/security

**PostHog**
- Feature flags — https://posthog.com/docs/feature-flags (+ /creating-feature-flags, /common-questions, /local-evaluation, /cleaning-up-stale-flags, /surfaces/mcp)
- Experiments — /docs/experiments (+ /statistics-frequentist, /statistics-bayesian, /metrics, /cuped, /holdouts, /exposures, /sample-size-running-time, /data-warehouse)
- Prompt management — https://posthog.com/docs/prompt-management · LLM analytics — /docs/llm-analytics · Self-driving — /docs/self-driving
- Access control — /docs/settings/access-control · SOC 2 — /docs/privacy/soc2 · HIPAA — /docs/privacy/hipaa-compliance
- Helm sunset (May 2023) — https://posthog.com/blog/sunsetting-helm-support-posthog
- Pricing — https://posthog.com/pricing · Platform packages — https://posthog.com/platform-packages

**Statsig, Eppo/Datadog, GrowthBook, Optimizely, Kameleoon**
- Statsig sequential testing, Autotune MAB and contextual (LinUCB), Safeguards, forward proxy — https://docs.statsig.com (/autotune/multi-armed-bandit, /autotune/contextual/methodology, /server/concepts/forward_proxy, /ai-evals/overview)
- Statsig pricing — https://www.statsig.com/pricing · Updates — https://www.statsig.com/updates
- OpenAI acquires Statsig (2025-09-02) — https://www.statsig.com/blog/openai-acquisition · Amplitude takes on Statsig (2026-05-05) — https://amplitude.com/blog/amplitude-and-statsig-partnership
- Eppo (Datadog) sequential testing, CUPED++, preferential Bonferroni, interaction effects, Certified Metrics — https://docs.geteppo.com
- Datadog acquires Eppo (2025-05-05) — https://www.datadoghq.com/about/latest-news/press-releases/datadog-acquires-eppo-to-expand-its-ai/
- Datadog Feature Flags GA (2026-02-03) — https://www.datadoghq.com/about/latest-news/press-releases/datadog-launches-feature-flags/ · Custom LLM-as-a-judge — https://docs.datadoghq.com/llm_observability/evaluations/custom_llm_as_a_judge_evaluations/
- GrowthBook statistics, quantile metrics, decision framework, AI integrations — https://docs.growthbook.io
- Optimizely 2026 release notes (CMAB GA 2026-04-28, MCP GA 2026-04-29) — https://support.optimizely.com/hc/en-us/articles/7663600395021
- Kameleoon statistics (Holm-Šidák, ACS with ϕ=2520, epsilon-decreasing bandits) — https://developers.kameleoon.com

**Statistical references cited by vendors**
- Howard et al., time-uniform confidence sequences — https://arxiv.org/pdf/1810.08240.pdf
- Waudby-Smith et al., asymptotic confidence sequences — https://arxiv.org/pdf/2103.06476v7.pdf
- Johari, Pekelis & Walsh, always-valid inference (mSPRT) — https://arxiv.org/abs/1512.04922
- Zhao et al., mSPRT for A/B testing — https://arxiv.org/pdf/1905.10493.pdf
- Li, Chu, Langford & Schapire, LinUCB — https://arxiv.org/pdf/1003.0146
- Tang et al., Overlapping Experiment Infrastructure (KDD 2010) — https://research.google/pubs/overlapping-experiment-infrastructure-more-better-faster-experimentation/

**Edge substrates**
- Vercel Global Config (formerly Edge Config; 1MB all plans, 15ms P99, ≤10s propagation) — https://vercel.com/docs/global-config (+ /migration-guide)
- Cloudflare Workers KV limits and consistency — https://developers.cloudflare.com/kv/platform/limits/ · /kv/concepts/how-kv-works/
- Flags SDK — https://flags-sdk.dev/

**Prompt management and gateways (adjacent)**
- Langfuse prompt management and evaluation — https://langfuse.com/docs/evaluation/experiments
- LangSmith online evaluations — https://docs.langchain.com/langsmith/online-evaluations
- Braintrust online scoring — https://www.braintrust.dev/docs/evaluate/score-online
- OpenRouter provider and model routing — https://openrouter.ai/docs/features/provider-routing · /model-routing
- LiteLLM routing (cost-based) — https://docs.litellm.ai/docs/routing

---

## Confidence and conflicts

Stated plainly rather than smoothed over.

- **Harness FME "AI Config Management"** was announced 2026-07-21 with a blog post and a marketing page and **has no documentation pages** in the 545-page FME doc tree, nor any release-note entry through 2026-08-18. Treat as announced, not shipped.
- **Statsig AI Experimentation enrollment**: `docs.statsig.com/llms.txt` says verbatim that it "is Early Access and is not accepting new customers" — a sentence that appears **only** in the agent-facing file and contradicts Amplitude's public GA timeline. Unresolved.
- **PostHog prompt management** has no GA badge and no locatable GA date. Do not assert one.
- **LaunchDarkly AgentControl packaging** is genuinely ambiguous: the docs say it "requires an add-on license… contact your account team," while the pricing page lists AI runs on every tier including free Developer with a self-serve overage price.
- **Harness FME pricing** publishes no list prices and no free-tier allowance, and `harness.io/pricing?module=ff` (FME is Enterprise-only) contradicts the FME docs (starting the Free Plan is a required step). Unresolved.
- **Flagsmith** has two live docs-vs-pricing contradictions: Scheduled Flags at Start-Up (pricing) vs Scale-Up (docs), and SAML at Scale-Up (pricing) vs Enterprise (access-control docs).
- **LaunchDarkly SCIM team sync** is documented as Okta-only on one page and Okta + OneLogin on another.
- **Harness FME EU data residency** appears not to be offered; confirmed only from a Harness-authored secondary source, not primary FME docs. Medium confidence.
- **PostHog's Terraform provider, a shipped CI code-references scanner, and the `/flags?v=2` response schema** could not be confirmed from primary sources.
- **Harness FME large-segment behaviour** at the proxy tier is undocumented; the Split help articles now redirect to the Harness docs root.
- **Unleash "no auto-rollback"** appears in competitor marketing but overstates the docs, which describe metric safeguards that disable an environment or pause a release plan. The docs were treated as authoritative here.
- **Absence from documentation is not absence from product.** Notably unverified negatives: Optimizely CUPED; Harness FME CUPED, Bayesian, bandits, holdouts, layers, and power calculator.
- **No vendor publishes p50/p95/p99 for flag delivery.** Every latency figure quoted in §4 is a marketing average, a laptop benchmark, or an adjective, and several trace back to 2021.
