# Design review — 2026-08-24

A point-in-time review of the overall design against the docs and the working tree,
answering two questions: **what still needs to be done**, and **is REST actually the
standard for feature-flag delivery?** Claims below were verified against the source tree,
not just the documentation.

> **Superseded in two places since it was written, on the same day.** The peeking fix has landed
> (see [DECISIONS.md](DECISIONS.md#rollout-monitoring)), and the Expo app was deleted rather than
> left undecided. Kept as written otherwise: it is a dated snapshot, and rewriting it would destroy
> the record of what was true when the priorities below were set.

Companions: [REMAINING-WORK.md](REMAINING-WORK.md) is the living backlog;
[competitive-gaps.md](competitive-gaps.md) is the dated market snapshot this derives from;
[DECISIONS.md](DECISIONS.md) records the choices.

---

## 1. Is REST the standard for feature toggles?

**Short answer: REST is the standard for the management plane and for the only open
delivery standard (OFREP) — but bare request/response REST is *not* the 2026 standard for
flag *delivery*. The industry-converged pattern is a REST bootstrap with ETag/304 plus SSE
push, with timer polling demoted to a fallback. Switchboard already ships exactly that
pattern, so transport is not a gap.**

### The industry evidence

- **OFREP, the only vendor-neutral delivery protocol, is REST/OpenAPI.** A gRPC variant
  exists only as an open discussion
  ([open-feature/protocol#72](https://github.com/open-feature/protocol/issues/72)) —
  surfaced at KubeCon EU 2026 because some organizations mandate gRPC for public APIs, but
  not specified, let alone adopted.
- **The OpenFeature project formally moved the ecosystem off naive polling in 2026.**
  ADR-0008 (2026-02-20) standardized SSE change-notification; ADR-0009 (2026-03-06)
  standardized ETag-keyed local persistence; ADR-0010 (2026-03-19) **removed default timer
  polling** from OFREP providers. See the ADRs in the
  [OFREP protocol repo](https://github.com/open-feature/protocol).
- **The incumbents converged on SSE from the other direction.** LaunchDarkly
  [moved from polling to SSE streaming](https://launchdarkly.com/blog/launchdarklys-evolution-from-polling-to-streaming/)
  years ago, and its FDv2 protocol (GA 2026-05-15) is still SSE — the 2026 innovation is
  delta/resumable semantics, not a new transport. Meanwhile Flagsmith's real-time SSE is
  Enterprise-only and its payload is a re-fetch ping; Unleash streaming is Enterprise-Edge
  beta; ConfigCat's cloud cannot push at all (its "realtime" is a webhook to your endpoint).
- **gRPC delivery exists but is niche**: flagd's sync protocol, Statsig's forward proxy,
  ConfigCat's self-hosted proxy. Nobody's primary hosted delivery path is gRPC.
- **WebSockets are essentially absent** from the field for flag delivery; SSE won because
  flag delivery is one-directional and SSE survives ordinary HTTP infrastructure.

### What Switchboard ships (verified in code)

| Surface | Transport | Details |
|---|---|---|
| `GET /api/eval/bootstrap` | REST | Full rule set; ETag = quoted env `stateVersion`, 304 on `If-None-Match` (`EvaluationController.java`) |
| `GET /api/stream` | SSE | `put` (full payload on connect) / `patch` (per-flag delta) / `ping`; `Last-Event-ID` accepted; fed by Postgres `LISTEN/NOTIFY` → `EnvironmentStreamHub` |
| `POST /api/eval[/{key}]` | REST | Server-side evaluated values; unknown flag → caller default at 200 |
| `POST /ofrep/v1/evaluate/flags[/{key}]` | REST | OFREP-conformant evaluated payloads, same ETag discipline; bulk response advertises the SSE stream via `eventStreams` |
| `GET /ofrep/v1/stream` | SSE | `refetchEvaluation` events — i.e. ADR-0008 behaviour, implemented |
| TypeScript SDK | SSE default, polling opt-in | `mode: 'streaming'` is the default (`sdk/typescript/src/client/config.ts`); local evaluation is the primary path; full-jitter reconnect backoff; polling uses `If-None-Match` |

No gRPC, WebSocket, or other push transport exists anywhere in the repo (grep-verified).
The dashboard and the Expo app are management-API clients only — plain REST, no SSE — which
is appropriate for human-paced UIs.

### Honest caveats

- **`Last-Event-ID` catch-up is trivially honored**: reconnect always sends a fresh full
  `put` rather than replaying missed patches. Correct, but the "catch-up" wording in older
  docs overstates it. Delta resume à la FDv2 is a possible later refinement, not a defect.
- **The SSE `put` and bootstrap payloads carry the full rule set plus segment
  `includedKeys`** — this is the already-known client-exposure defect
  (REMAINING-WORK.md §2), and it is a *payload* problem, not a transport one.

### Verdict for the roadmap

Keep the transport exactly as it is. The delivery work that matters is already on the
backlog and is payload- and security-shaped: client-side key kinds with an
evaluated-payload bootstrap, SDK local persistence (ADR-0009's direction), and — much
later, if ever — edge/CDN delivery.

---

## 2. What still needs to be done

The backlog in [REMAINING-WORK.md](REMAINING-WORK.md) held up under review: every claim
spot-checked against the tree was accurate except one, now corrected — the repo is no
longer uncommitted (5 commits on `main` as of this review). The verified priority order:

1. **Peeking fix in `RolloutMonitorService`** — the fixed-horizon z-test evaluated
   repeatedly is a statistical defect in the headline differentiator. Sequential/
   anytime-valid statistic + SRM gate + multiplicity correction. Small, contained,
   disproportionate credibility payoff.
2. **Bootstrap exposure / client key kinds** — a security bar that must be met before any
   browser or mobile client uses Switchboard. One key kind exists today.
3. **Cache metrics, then the SDK-key cache** — every evaluation request currently pays a
   three-table SQL join for key resolution; the cheapest large performance win.
4. **Personal access tokens → MCP server** — PATs unblock MCP and a CLI; MCP is
   table stakes (12+ vendors ship one).
5. **Typed attributes + full operator set** — the most visible gap in a live demo
   ("app version ≥ 4.2.0 on iOS" is inexpressible). Spec-first rule applies: spec edit +
   regenerated conformance vectors in the same commit.
6. **CI and a deployment story** — neither exists; everything is run by hand.

Blocked on a human rather than an agent: an `ANTHROPIC_API_KEY` (the natural-language
prompt-to-diff loop has never actually executed), the mobile app keep-or-drop decision,
and a visual pass in light and dark.

### State of the tree, verified

- Spec + conformance: `spec/evaluation.md` plus **201 vectors** in `spec/conformance/`
  (22 bucket + 168 evaluation cases + 11 rollout-weight validations), executed by both the
  Java server and the TypeScript SDK.
- OFREP: `OfrepController`, `OfrepStreamController`, 13 DTOs — present and hand-bound for
  documented reasons.
- Governance: `ChangeRequestsController`, migrations `V2` (scoped RBAC + change requests)
  and `V3` (AI-proposal convergence step 1) — approvals and scoped RBAC are landed, not
  pending.
- Identity: `V4` provider-agnostic identities; backend and dashboard are Firebase-free;
  the Expo app still hardcodes Firebase (known, waits on keep-or-drop).

### Doc corrections made in this review

- `REMAINING-WORK.md`: "the repo has zero commits" struck (done).
- `competitive-gaps.md`: marked as a dated snapshot; three overtaken claims annotated
  (empty `spec/conformance/`, "no SDKs / no OFREP", "no approvals / no RBAC").
- `DECISIONS.md`: the delivery-transport choice recorded so it is changed deliberately or
  not at all.

Sources: [OFREP protocol repo (ADRs 0005, 0008–0010)](https://github.com/open-feature/protocol) ·
[OFREP overview](https://openfeature.dev/docs/reference/other-technologies/ofrep/) ·
[gRPC discussion #72](https://github.com/open-feature/protocol/issues/72) ·
[LaunchDarkly: polling to streaming](https://launchdarkly.com/blog/launchdarklys-evolution-from-polling-to-streaming/) ·
[Streaming vs polling deep dive (FeatBit)](https://www.featbit.co/blogs/streaming-vs-polling-for-feature-flags) ·
[flagd OFREP service](https://flagd.dev/reference/flagd-ofrep/)
