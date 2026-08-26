# Development

Repository layout, how to run each piece, and how to verify a change.

Working on this with an agent? [`CLAUDE.md`](../CLAUDE.md) carries the environment traps that have
each cost real time — read it first.

---

## Layout

A monorepo. Everything below is one git repo, brought up together by the root `Makefile` and
`docker-compose.yml`.

```
evaluation/ The flag evaluation core — bucketing, operators, precedence. Pure JDK, no dependencies.
backend/    Spring Boot (WebFlux, R2DBC, Flyway) — DDD: domain / application / infrastructure / interfaces
dashboard/  Web UI — React + Vite (the primary management surface)
sdk/        Client libraries — sdk/typescript and sdk/java, both OpenFeature providers with local evaluation
spec/       Normative evaluation spec + conformance vectors (the cross-language contract)
scripts/    seed-local.mjs · smoke-test.mjs · load-test.mjs · load-volume.mjs · token.sh · resolve-java.sh
docs/       Architecture, governance, the AI layer, performance, the backlog, market research
```

**`evaluation/`, `backend/` and `sdk/java/` are one Maven reactor**, aggregated by the root
`pom.xml`. The server and the Java SDK compile against the same evaluator rather than each
carrying their own, which is what makes it impossible for them to disagree about bucketing or
precedence — see [DECISIONS.md](DECISIONS.md#the-evaluation-core).

There was an Expo mobile companion; it was deleted on 2026-08-24 and is in git history if it is
ever wanted back. See [DECISIONS.md](DECISIONS.md#product-scope).

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
make smoke   # 51 API cases end to end, negative paths included
make check   # compile + checkstyle
```

Per component:

```bash
# From the REPO ROOT for anything JVM: evaluation/, backend/ and sdk/java/ are one reactor.
JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw verify                    # all three
JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw -pl backend -am verify    # backend + what it needs
JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw -pl evaluation verify     # the core + its vectors

cd dashboard      && npm run check && npm run build
cd sdk/typescript && npx vitest run
cd mcp            && npm run check
```

**`cd backend && ./mvnw verify` no longer works on a clean checkout**, and the error will not
tell you why: a single-module build resolves `switchboard-evaluation` from your local repository
rather than from the reactor, so it fails with a missing artifact. Build from the root, or run
`make core` once to install the module.

**Java 25 is required and the shell default may not be it.** Prefix every Maven call with
`JAVA_HOME=$(/usr/libexec/java_home -v 25)`.

### The live checks

Seven scripts run against a **running** stack and are the real regression net — they catch contract
drift that unit tests cannot:

```bash
node scripts/smoke-test.mjs                    # 51  · repo root
node sdk/typescript/scripts/live-check.mjs     # 32  · client vs server agreement
node dashboard/scripts/service-check.mjs       # 67
node dashboard/scripts/ai-check.mjs            # 54
node dashboard/scripts/governance-check.mjs    # 38
node dashboard/scripts/auth-check.mjs          # 19  · needs a second OIDC provider; it prints the command
node mcp/scripts/live-check.mjs                # 19  · every MCP tool against a real stack
```

The Java SDK's live check is a JUnit test rather than a script, because driving a JVM SDK from
node would prove nothing about the JVM SDK. It self-skips without a key:

```bash
SWITCHBOARD_SDK_KEY=sb_srv_production_... \
  JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw -pl sdk/java -am test -Dtest=LiveCheckIT \
  -Dsurefire.failIfNoSpecifiedTests=false
```

It asserts the SDK's **in-process** answers equal the **server's** for the same flags and
contexts — two entirely different code paths, which is what makes the agreement worth
asserting. It is also what caught the SDK rejecting every real bootstrap payload over a
wire-format detail that no hand-written fixture happened to contain.

**Two of the scripts import from `dist/` rather than from source** — the SDK's and the MCP server's —
because the point of a live check is to exercise what actually ships. On a clean checkout, run
`npm run build` in those two packages first; without it they fail with `ERR_MODULE_NOT_FOUND`,
which says nothing about the stack they were meant to be checking.

Run all of them after any backend change. If one fails in a tree you do not own, say so rather than
"fixing" it.

`make smoke` alone is the fastest honest answer to "is it working". See [TESTING.md](../TESTING.md)
for the manual passes, including the kill-switch drill and the SSE watch.

### CI

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) runs all of the above on every pull
request. Two jobs are worth knowing about before you edit it:

**`conformance`** is its own job rather than a step inside `backend` or `sdk`, because it belongs
to neither: it runs the Java vector runner, the TypeScript one, and `generate-vectors.mjs --check`.
A failure there means the two implementations have DRIFTED, which is a different diagnosis from
either one being broken.

**`live`** brings up compose, starts the backend and seeds it, then runs all seven scripts. It
configures a **second identity provider** so `auth-check`'s OIDC leg actually runs — the local
issuer binds a fixed port, so the backend can be told about it before it exists, and the JWK set
is fetched lazily at the first token. A permanently-skipped check is worse than no check.

There is also a `containers` job that builds both production images and brings up
`docker-compose.prod.yml` for real. It catches what a Dockerfile lint cannot: a missing migration
on a fresh volume, a probe pointed at the wrong port, a runtime config that never reaches the
browser. See [DEPLOYMENT.md](DEPLOYMENT.md).

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
