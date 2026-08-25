# CLAUDE.md

Working notes for Claude Code sessions in this repo. Read this before touching anything —
most of what follows was learned by getting it wrong first.

## What this is

Switchboard: a feature-flag platform whose distinguishing feature is an AI layer that
**heals** bad rollouts (detects a variant erroring, rolls it back) and **optimizes** good
ones (detects a variant converting better, ramps it up), plus natural language to a typed
reviewable diff. A monorepo.

| Path | What | Tests |
|---|---|---|
| `backend/` | Spring Boot · WebFlux · R2DBC · Flyway · Postgres. DDD layering. | 642 unit + 111 integration |
| `dashboard/` | React + Vite. **The primary UI.** | 329 |
| `sdk/typescript/` | OpenFeature provider with local evaluation | 562 |
| `mcp/` | MCP server over the REST API, authenticated by a personal access token | 7 |
| `spec/` | Normative evaluation spec + 508 conformance vectors | executed by backend and SDK |
| `scripts/`, `docs/` | Seed, smoke suite, tooling · backlog and competitive research | |

**Two contracts, both enforced rather than described.** `backend/src/main/resources/openapi/switchboard-api.yaml`
generates the server interfaces and the clients mirror it. `spec/evaluation.md` plus
`spec/conformance/` define evaluation *behaviour*, and both the Java server and the
TypeScript SDK execute those vectors as tests.

## Running it

```bash
make deps-up     # postgres 18 (:25432) + firebase auth emulator (:29099)
make backend     # :28080, local profile
make seed        # demo workspace via the public API; prints SDK keys once
make dashboard   # :5273 -- the main UI
```

Seed logins, password `password123`: `alice@switchboard.dev` (owner),
`bob@switchboard.dev` (member), `carol@beta.dev` (a second org, proving isolation).

Local dev also accepts **dev tokens**: `Authorization: Bearer dev:<email>` authenticates as
that user, auto-provisioning. Every check script uses them.

## Gotchas that have already cost time

**Java 25 is required and the shell default is Java 8.** Prefix every Maven call:
`JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw ...`. Without it the build fails in
confusing ways.

**`FIREBASE_AUTH_EMULATOR_HOST=localhost:29099` is mandatory when running the backend on the
host.** Without it the Admin SDK verifies emulator tokens against real Google and rejects
every real login with a 401 — *while dev tokens keep working*, which is exactly what makes
the omission invisible. `make backend` sets it. Reproduced deliberately; documented in
`backend/README.md`.

**The packaged jar cannot talk to the Firebase emulator.** `firebase-admin` is `<optional>`
and Spring Boot's fat jar leaves optional dependencies out, so `java -jar target/*.jar` with
`FIREBASE_AUTH_EMULATOR_HOST` set **refuses to start**. `./mvnw spring-boot:run` has it, which
is why `make backend` works. Deliberate in both directions — a production deployment on Okta
should not carry the SDK — and the reason CI's `live` job uses `spring-boot:run`.

**Never run a broad `pkill -f spring-boot:run`.** It has twice killed a backend another
process was depending on. Find the specific PID.

**macOS has no `timeout` command.** Do not use it in scripts.

**Changing a `public static final String` needs `./mvnw clean`.** javac inlines compile-time
String constants into every class that reads one, and the incremental build will not recompile
those classes just because the constant changed — so tests keep asserting the *old* literal and
fail with a message quoting a value that no longer exists in the source. Cost an unnecessary
debugging detour once; a clean build is the whole fix.

**Actuator lives on its own port** (`MANAGEMENT_PORT`, default 28081), and that includes
`/actuator/health` — it 404s on 28080. Health checks and probes must target the management
port. That listener is unauthenticated by design: keep it off the public interface.

## Conventions

**Backend.** `domain/` is pure Java — no Spring, no vendor names, no JWT libraries; a
violation there is a design defect, not a style one. `application/` composes ports and uses
`TransactionalOperator`. `infrastructure/` holds `DatabaseClient` adapters. `interfaces/rest`
controllers are thin and implement generated interfaces with static mappers.

The versioned write path (`FlagTargetingService`) is load-bearing: `SELECT ... FOR UPDATE`
→ validate `expectedVersion` (409 if stale) → head write at version+1 → immutable snapshot →
audit row → `state_version` bump → `pg_notify` after commit. **Every** flag mutation goes
through it, including AI-applied and approval-applied ones. Rollback writes a *new* version;
history is never rewritten.

**Dashboard.** No React Query — pages use `useState` + `useEffect` + async `load()` with
loading/error/refreshing flags and toasts for writes. Semantic tokens only, no raw hex, use
the `warning` token rather than amber. Filter and tab state lives in query params. One API
module per endpoint group over `src/lib/apiClient.ts`.

**Two compose files, two project names.** `docker-compose.yml` is the dev stack;
`docker-compose.prod.yml` is the deployable one and sets `name: switchboard-prod`. That line
is load-bearing: without it Compose derives the project name from the directory, both files
become `switchboard`, and `up` on the prod file **recreates the dev postgres container in
place** against the dev volume with production's credentials. Done accidentally once; the
volume survived, the running backend did not.

**Dashboard configuration is runtime, not build-time** — the container writes `/config.js`
from its environment and `src/lib/runtimeConfig.ts` layers it over `import.meta.env`, so one
image serves any environment. The exception is `VITE_AUTH_PROVIDER`, which decides which auth
implementation is *bundled*; a runtime override of it is reported as an error rather than
silently ignored.

**Caching goes through `CacheRegistry` / `SwitchboardCache`** — a reactive seam over Caffeine,
provider chosen by `switchboard.cache.provider`. **Do not reach for `@Cacheable`**: on a method
returning `Mono` it caches the cold publisher rather than the value, so it appears to work while
doing nothing. The seam sidesteps that (and the self-invocation trap) by not using proxies at all.
Add a cache by adding a `CacheName` enum constant — names are an enum so a typo is a compile error,
and keys are Strings so they survive the `NOTIFY` invalidation channel intact. Reasoning in
`docs/DECISIONS.md`.

**Evaluation behaviour is spec-first.** Any change to precedence, operators, segments or
bucketing must land as a `spec/evaluation.md` edit **plus updated conformance vectors in the
same commit**. That rule is the only thing keeping the server and every SDK in agreement.
`spec/tools/generate-vectors.mjs` writes the combinatorial vectors (`operators.json`); the rest
are hand-authored. `--check` fails when they are stale. The runners no longer hardcode a count.

**Flyway.** Migrations are `V1`–`V7` today; the next is **V8**. They run automatically
locally.

## Verifying

```bash
cd backend    && JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw verify
cd backend    && JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw -q compile checkstyle:check
cd dashboard  && npm run check && npm run build
cd sdk/typescript && npx vitest run
cd mcp        && npm run check
```

Seven live scripts run against a **running** stack and are the real regression net — they
catch contract drift that unit tests cannot:

```bash
node scripts/smoke-test.mjs                    # 34  · repo root
node sdk/typescript/scripts/live-check.mjs     # 32  · client vs server agreement
node dashboard/scripts/service-check.mjs       # 67
node dashboard/scripts/ai-check.mjs            # 53
node dashboard/scripts/governance-check.mjs    # 38
node dashboard/scripts/auth-check.mjs          # 19  · needs a second OIDC provider configured; it prints the command
node mcp/scripts/live-check.mjs                # 19
```

Run all of them after any backend change. If one fails in a tree you do not own, say so
rather than "fixing" it.

All of it runs in `.github/workflows/ci.yml` on every PR, live checks included. The `live`
job configures the second OIDC provider up front so auth-check's OIDC leg actually runs; the
`containers` job builds both production images and brings `docker-compose.prod.yml` up for
real. If you change a check script, a port, or a seed default, that workflow is the other
place it has to be true.

### Tight loops

Do not run the full suite to check one thing. These are verified working:

```bash
# one unit test class (fast, no container)
cd backend && JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw test -Dtest=FlagEvaluatorTest -Dcheckstyle.skip

# one integration test class (starts Testcontainers, ~10s)
cd backend && JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw verify -Dit.test=EvalApiIT -Dsurefire.skip=true -Dcheckstyle.skip

cd dashboard && npx vitest run src/lib/__tests__/rollout.test.ts
cd sdk/typescript && npx vitest run test/conformance.test.ts
```

Backend logs go to `/tmp/sb-boot.log` when started the way `make backend` starts it. A
`DnsServerAddressStreamProviders` error on macOS during tests is noise, not a failure.

Reset the local database — it accumulates throwaway users, orgs and flags from verification
runs:

```bash
docker compose down -v && docker compose up -d --wait   # then restart backend, then: make seed
```

## Working with multiple agents

**One writer per tree.** `backend/`, `dashboard/`, `sdk/` and `spec/` are separate
trees; two agents writing the same one will collide. Reading any tree is always fine.

Agents have stalled mid-task more than once. When resuming, **inventory what actually exists
before rewriting** — a compile and a test run usually reveal that most of the work landed
and only the verification step is missing.

**Verify agent reports rather than trusting them.** A stalled agent's unverified work is not
working code. Re-running claimed results has repeatedly found real problems: a test querying
a column that does not exist, a baseline chosen by random UUID that only showed up as a
flaky test, a check script defaulting to a user that was never seeded.

## Where things stand

`docs/REMAINING-WORK.md` is the backlog: what is missing, why it matters, effort estimates,
and a suggested order. `docs/DECISIONS.md` records the choices that look wrong until you know
why — **read it before "fixing" something that seems obviously broken**, because several
things are deliberate (the kill switch bypassing approval, MD5 bucketing, permissions
unioning rather than narrowing, an unknown flag returning 200). `docs/competitive-gaps.md`
is the market research the backlog derives from. `docs/DEPLOYMENT.md` covers containers,
configuration, migrations, retention and when Redis actually becomes necessary.

Two things need a human rather than an agent: an `ANTHROPIC_API_KEY` (natural-language
flag creation has never actually executed — everything else in the AI layer works without
one), and a visual pass in light and dark. The Expo mobile companion was **deleted** on
2026-08-24; see `docs/DECISIONS.md`. It is in git history if it is ever wanted back.

The local dev database accumulates throwaway data from verification runs. `docker compose
down -v` then `make deps-up`, restart the backend, and re-seed for a clean demo state.
