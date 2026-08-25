# Development

Repository layout, how to run each piece, and how to verify a change.

Working on this with an agent? [`CLAUDE.md`](../CLAUDE.md) carries the environment traps that have
each cost real time — read it first.

---

## Layout

A monorepo. Everything below is one git repo, brought up together by the root `Makefile` and
`docker-compose.yml`.

```
backend/    Spring Boot (WebFlux, R2DBC, Flyway) — DDD: domain / application / infrastructure / interfaces
dashboard/  Web UI — React + Vite (the primary management surface)
sdk/        Client libraries — sdk/typescript is an OpenFeature provider with local evaluation
spec/       Normative evaluation spec + conformance vectors (the cross-language contract)
scripts/    seed-local.mjs · smoke-test.mjs · token.sh · resolve-java.sh
docs/       Architecture, governance, the AI layer, the backlog, market research
app/        Expo mobile companion — UNMAINTAINED since 2026-08-24, see DECISIONS.md
```

Each component carries its own README: [backend](../backend/README.md),
[dashboard](../dashboard/README.md), [SDK](../sdk/typescript/README.md), [spec](../spec/README.md).

## Running it

```bash
make deps-up     # postgres 18 (:25432) + firebase auth emulator (:29099)
make backend     # spring boot on :28080 (local profile: dev tokens on)
make seed        # demo workspace, driven through the public API
make dashboard   # web dashboard on :5273  <- the main UI
```

Seed logins are `alice@switchboard.dev` (owner), `bob@switchboard.dev` (member),
`carol@beta.dev` (a second org, proving isolation) — password `password123`. The seed prints one SDK
key per environment; they are shown once and stored hashed.

Local ports: backend **28080**, management/actuator **28081**, dashboard **5273**, postgres
**25432**, auth emulator **29099**.

Local dev also accepts **dev tokens**: `Authorization: Bearer dev:<email>` authenticates as that
user, auto-provisioning. Every check script uses them.

## Verifying

```bash
make test    # unit + integration (Testcontainers), including the concurrency race tests
make smoke   # ~35 API cases end to end, negative paths included
make check   # compile + checkstyle
```

Per component:

```bash
cd backend        && JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw verify
cd dashboard      && npm run check && npm run build
cd sdk/typescript && npx vitest run
```

**Java 25 is required and the shell default may not be it.** Prefix every Maven call with
`JAVA_HOME=$(/usr/libexec/java_home -v 25)`.

### The live checks

Six scripts run against a **running** stack and are the real regression net — they catch contract
drift that unit tests cannot:

```bash
node scripts/smoke-test.mjs                    # 34  · repo root
node sdk/typescript/scripts/live-check.mjs     # 32  · client vs server agreement
node dashboard/scripts/service-check.mjs       # 67
node dashboard/scripts/ai-check.mjs            # 53
node dashboard/scripts/governance-check.mjs    # 38
node dashboard/scripts/auth-check.mjs          # 19  · needs a second OIDC provider; it prints the command
```

Run all of them after any backend change. If one fails in a tree you do not own, say so rather than
"fixing" it.

`make smoke` alone is the fastest honest answer to "is it working". See [TESTING.md](../TESTING.md)
for the manual passes, including the kill-switch drill and the SSE watch.

## Resetting local state

The dev database accumulates throwaway users, orgs and flags from verification runs:

```bash
docker compose down -v && docker compose up -d --wait   # then restart the backend, then: make seed
```

## Observability

The actuator lives on its own port (`MANAGEMENT_PORT`, default 28081), including
`/actuator/health` — health probes must target the management port, not the API port.
`/actuator/prometheus` exposes cache hit rate, the two hot-path timers and SSE subscriber counts.

That listener is unauthenticated by design: bind it to the pod or host network and do not publish it.
