# Deployment

The operator reference for running Switchboard somewhere other than a laptop.

**Setting up a new instance? Start with [self-hosting.md](self-hosting.md)**, which walks through
it in order — identity provider, first admin, inviting the team, building the SDKs. This page is
the reference behind it: every setting, the management port, scheduled jobs, migrations,
retention, backups and scaling. [development.md](development.md) covers the local stack; the
differences are mostly about what must *not* carry over.

---

## The short version

```bash
cp .env.prod.example .env          # then edit it — POSTGRES_PASSWORD has no default
docker compose -f docker-compose.prod.yml up --build -d --wait
```

Three containers: Postgres, the backend, and the dashboard behind nginx. The backend migrates the
schema on boot, so there is no separate install step and the first `up` on an empty volume is a
working install.

Then sign in: Switchboard creates a user on the first authenticated request, and under the
`bootstrap` org-creation mode (the default here) the first person to sign in creates the
organization and invites everyone else. See [self-hosting.md](self-hosting.md#7-the-first-admin-signs-in-and-creates-the-organization)
and [governance.md](governance.md).

## What is deliberately absent from a production image

**`FIREBASE_AUTH_EMULATOR_HOST`.** Locally it is mandatory; without it the Admin SDK verifies
emulator tokens against real Google and rejects every login with a 401 (see
[development.md](development.md)). In production the same variable points the Admin SDK at a host
that is not Google, for *real* users' tokens. It is not set in `backend/Dockerfile` and not set in
`docker-compose.prod.yml`, and the dashboard's own `VITE_FIREBASE_AUTH_EMULATOR_HOST` is
explicitly blanked there for the same reason.

**Dev tokens.** `Authorization: Bearer dev:<email>` authenticates as anyone. It exists only under
the `local` Spring profile (`switchboard.security.dev-auth-enabled`), which the production image
does not activate. If you ever see it work against a deployment, that deployment is open to the
internet as every user at once.

**The seed data.** `make seed` creates alice/bob/carol with the password `password123`. It is a
demo fixture driven through the public API, not an installer, and it has no place here.

**`firebase-admin`.** It is an *optional* Maven dependency and Spring Boot's packaged jar leaves
it out, so the production image does not contain it. That is deliberate: the emulator issues
unsigned tokens that only the Admin SDK will accept, while production Firebase is an ordinary
OIDC issuer that needs none of it — as are Okta, Auth0, Entra ID and Keycloak. The consequence
worth knowing: `java -jar` with `FIREBASE_AUTH_EMULATOR_HOST` set refuses to start, with a
message naming both ways out. Running the emulator locally means `make backend`
(`mvnw spring-boot:run`), which uses the full compile classpath.

## Configuration

### Backend

| Variable | Default | What it is |
|---|---|---|
| `DB_HOST` `DB_PORT` `DB_NAME` `DB_USER` `DB_PASSWORD` | localhost:25432/switchboard | Used for both R2DBC (runtime) and JDBC (Flyway). One database, two drivers. |
| `SERVER_PORT` | `28080` | The API listener. |
| `MANAGEMENT_PORT` | `28081` | Actuator. See [The management port](#the-management-port). |
| `FLYWAY_ENABLED` | `true` | Migrate on boot. |
| `FIREBASE_PROJECT_ID` | `demo-switchboard` | Only meaningful for the default Firebase provider. |
| `SWITCHBOARD_ORG_CREATION` | `open` (`bootstrap` in `docker-compose.prod.yml`) | Who may create an organization. `open`: anyone signed in. `bootstrap`: only the first person, while no org exists; everyone else joins by invitation. Any other value fails startup. See [self-hosting.md](self-hosting.md#org-creation-open-or-bootstrap). |
| `JOB_TOKEN` | *(empty)* | Shared secret for `POST /api/jobs/*`, sent as `X-Job-Token`. Empty closes the HTTP triggers. See [Scheduled jobs](#scheduled-jobs) — three of the jobs only run this way. |
| `JOBS_SCHEDULED_ENABLED` | `true` | The in-process rollout scan and webhook sweep. Turn off if an external scheduler drives them instead. |
| `ANTHROPIC_API_KEY` | *(empty)* | Natural-language flag authoring only. Healing, optimizing and the stale sweep work without it. |
| `RATELIMIT_ENABLED` `RATELIMIT_RPM` `RATELIMIT_BURST` | `true` `6000` `600` | Per credential, per instance. See [Rate limiting](#rate-limiting-and-the-honest-answer-about-redis). |
| `EVENT_RETENTION_MONTHS` | `3` | See [Retention](#retention). |
| `EVENT_PARTITION_MONTHS_AHEAD` | `2` | How far ahead the roll job creates partitions. |
| `AUDIT_RETENTION_MONTHS` | `0` (keep forever) | Deletes audit entries older than this, when the audit-retention job runs. Off by default on purpose. |

`docker-compose.prod.yml` passes through every variable above, plus `SPRING_APPLICATION_JSON`
(empty by default), and `.env.prod.example` lists them. Anything else goes in an override file
added with a second `-f`.

**Properties without a dedicated variable** are still settable from the environment through
Spring's relaxed binding — upper-case, dots to underscores, dashes dropped
(`switchboard.rollout-monitor.min-subjects` → `SWITCHBOARD_ROLLOUTMONITOR_MINSUBJECTS`) — or all
at once through `SPRING_APPLICATION_JSON`. The ones an operator may want:

| Property | Default | What it is |
|---|---|---|
| `spring.r2dbc.pool.initial-size` / `max-size` | `2` / `10` | Connections per instance. See [Scaling past one node](#scaling-past-one-node). |
| `switchboard.rollout-monitor.enabled` | `true` | The rollout scan at all. |
| `switchboard.rollout-monitor.min-subjects` | `200` | Distinct subjects each arm needs before it is compared. |
| `switchboard.rollout-monitor.max-lookback` | `P30D` | Ceiling on the evidence window. |
| `switchboard.rollout-monitor.scan-concurrency` | `4` | Flags aggregated in parallel per scan. |
| `switchboard.rollout-monitor.alpha.heal` / `.optimize` / `.srm` | `0.05` / `0.01` / `0.001` | Error budgets for rollback, ramp and the sample-ratio gate. |
| `switchboard.rollout-monitor.srm.enabled` / `.min-subjects` | `true` / `500` | The sample-ratio-mismatch gate. |
| `switchboard.rollout-monitor.aggregate-work-mem` | *(unset)* | e.g. `64MB`; raises Postgres `work_mem` for the scan's aggregation only. |
| `switchboard.cache.provider` | `caffeine` | The cache seam. Caffeine is the only provider today. |
| `switchboard.webhooks.timeout-seconds` / `sweep-batch` | `5` / `100` | Per-delivery timeout; retries per sweep. |
| `switchboard.scim.default-role` | `MEMBER` | Role given to a user provisioned over SCIM. |
| `switchboard.sdk.client-keys.allow-metric-events` | `false` | Accept metric events from public client keys. Read `EventsController` before turning it on. |

Which metric keys the monitor tests, their direction and their thresholds are per project, not
here — see [ai-layer.md](ai-layer.md#configuration).

Identity providers are structured configuration rather than flat variables, so they come in
through `SPRING_APPLICATION_JSON`:

```bash
SPRING_APPLICATION_JSON='{"switchboard":{"auth":{"providers":[
  {"id":"corp-okta","type":"oidc","issuer":"https://acme.okta.com/oauth2/default",
   "audience":"switchboard-api","email-claim":"email","name-claim":"name"}]}}}'
```

More than one may be active at once — routing is by the token's `iss` — which is what makes an IdP
migration possible without a flag day. Identity is `(issuer, subject)`, so the same person
arriving through a second issuer resolves to the same Switchboard user by email.

### Dashboard

**Configuration arrives at runtime, not at build time.** A Vite build normally folds every
`VITE_*` into the bundle as a literal, which would pin an image to one API URL and one IdP —
staging and production would be different images of the same commit, and "did we deploy the right
build" becomes a question anyone can get wrong. Instead the container writes `/config.js` from its
environment at start-up and the app layers it over the build-time defaults
(`dashboard/src/lib/runtimeConfig.ts`).

The one exception is **`VITE_AUTH_PROVIDER`, which is a build argument**:

```bash
docker build --build-arg VITE_AUTH_PROVIDER=oidc -t switchboard-dashboard:oidc dashboard

# The BACKEND image builds from the REPOSITORY ROOT, not from backend/. It compiles against the
# sibling evaluation/ module, which a backend-only context cannot see:
docker build -t switchboard-backend -f backend/Dockerfile .
```

`src/auth/index.ts` places its two dynamic imports either side of a literal comparison, so the
bundler drops the losing branch entirely. A default build does not *contain* `oidc-client-ts`; an
`oidc` build does not contain Firebase. Setting it at runtime is reported as an error on first
paint rather than ignored, because the alternative is an operator who sees the login page render
and discovers the wrong IdP only when somebody clicks *Sign in*.

Everything else is runtime: `VITE_API_BASE_URL`, the Firebase block, the OIDC block. The full list
is in `dashboard/docker-entrypoint.d/10-runtime-config.sh`.

> **`VITE_API_BASE_URL` is resolved by the browser, not by the container.** It must be a URL a
> *user's* browser can reach — never `http://backend:28080`. This is the most common first-deploy
> failure and it presents as "the dashboard loads but nothing works".

## The management port

Actuator is on its own listener (`MANAGEMENT_PORT`, default 28081) so the scrape endpoint is never
on the public one. `health`, `info`, `metrics` and `prometheus` are exposed there;
`health/readiness` and `health/liveness` are the probe paths.

**This takes `/actuator/health` with it.** A probe pointed at `SERVER_PORT` gets a 404 and the pod
never becomes ready. That is worth stating plainly because the symptom — a healthy application
that an orchestrator refuses to route to — looks like anything but a port number.

`docker-compose.prod.yml` does not publish 28081. The *port*, not the filter chain, is the
boundary: the endpoints are named `permitAll` in `SecurityConfig` precisely because the port is
expected not to be reachable. Scrape it from inside the network; give a monitoring host access by
putting it on the network, never by publishing the port.

```yaml
# Kubernetes
readinessProbe:
  httpGet: { path: /actuator/health/readiness, port: 28081 }
livenessProbe:
  httpGet: { path: /actuator/health/liveness, port: 28081 }
  initialDelaySeconds: 60
```

## Scheduled jobs

Five maintenance jobs, each an idempotent `POST /api/jobs/<name>` authenticated by the
`X-Job-Token` header (`JOB_TOKEN`). Only two also run on a timer inside the backend:

| Job | In-process timer | Suggested external schedule |
|---|---|---|
| `rollout-scan` | hourly | optional; drive it externally if instances scale to zero |
| `webhook-sweep` | every 30 s | optional, as above |
| `partition-roll` | **none** | daily |
| `stale-flag-scan` | **none** | daily |
| `audit-retention` | **none** | daily, only if `AUDIT_RETENTION_MONTHS` is set |

So a deployment that never calls the other three never creates event partitions ahead, never
expires old events, and never drafts stale-flag proposals. Set `JOB_TOKEN` and add them to cron
(or a Kubernetes `CronJob`) on the host:

```cron
15 3 * * *  curl -fsS -X POST -H "X-Job-Token: $JOB_TOKEN" http://127.0.0.1:28080/api/jobs/partition-roll
30 3 * * *  curl -fsS -X POST -H "X-Job-Token: $JOB_TOKEN" http://127.0.0.1:28080/api/jobs/stale-flag-scan
45 3 * * *  curl -fsS -X POST -H "X-Job-Token: $JOB_TOKEN" http://127.0.0.1:28080/api/jobs/audit-retention
```

## Migrations

Flyway runs on boot against the JDBC URL and is the only thing that touches the schema. For a
single instance that is the right default and nothing below applies.

For **more than one instance**, it still works — Flyway takes a lock, so the losers wait rather
than racing — but boot time becomes migration time for whichever instance wins, and a failed
migration is a failed start. The usual answer is to set `FLYWAY_ENABLED=false` on the application
and run migrations as a separate step (a Kubernetes `Job`, a deploy hook) before the new version
rolls out. That also forces the discipline that makes rolling deploys safe: **a migration must be
compatible with the previous version of the code**, because both will be running at once.

Migrations are `V1`–`V14`; the next is `V15`.

## Rate limiting, and the honest answer about Redis

The limiter is a token bucket per credential, held **in memory, per instance**. Two instances mean
two buckets and therefore twice the configured rate. That is stated rather than hidden because it
is the first thing in Switchboard that genuinely wants a shared store — everything else that looks
like it needs one does not:

- **The caches do not.** They are read-through caches of data that can be recomputed, and Postgres
  `NOTIFY` already invalidates every instance. A shared cache would be a correctness *equal* and a
  latency loss. The seam is in place (`switchboard.cache.provider`) for the day the cold-start cost
  of many instances outweighs that.
- **Delivery does not.** SSE fan-out is driven by `LISTEN`/`NOTIFY`, so every instance learns about
  a change from the database it already has a connection to.

So: run one instance until the limiter's per-instance drift matters, then divide the limits by the
instance count, then reach for Redis. In that order.

## Retention

`eval_events` and `metric_events` are monthly-partitioned. The roll job (`POST
/api/jobs/partition-roll` — **not** run in-process; see [Scheduled jobs](#scheduled-jobs)) creates
`EVENT_PARTITION_MONTHS_AHEAD` months forward and **drops whole partitions** older than
`EVENT_RETENTION_MONTHS`. Until it runs, events still land safely in the `DEFAULT` partition, but
nothing is ever expired.

Two things follow, and both matter:

**Lowering retention is immediate and destructive.** The next roll drops the partitions the new
window excludes. There is no soft delete and no archive step. Export first if you want the data.

**Retention bounds what the healing loop can see.** The rollout monitor accumulates evidence from
the current allocation epoch, capped at 30 days (`rollout-monitor.max-lookback`). Three months
covers that comfortably. Set retention below one month and the job clamps to one, because the
current month's partition is the one being written to and dropping it would delete live data
rather than expire old data.

Epoch evidence (`rollout_epoch_evidence`) is pruned on the same window, deliberately: evidence
about events that have been dropped cannot be rechecked, and a finding whose basis no longer
exists is worse than no finding.

**The audit log is kept forever by default.** `AUDIT_RETENTION_MONTHS=0` means no expiry; set a
window only if a policy requires one. It is a row-wise `DELETE`, run by `POST
/api/jobs/audit-retention`. Export first (`GET /api/orgs/{orgId}/audit/export`, NDJSON or CSV) if
you need the history elsewhere.

The one thing never dropped is each table's `DEFAULT` partition — it is what keeps an out-of-range
event from being rejected outright, and dropping it would lose every row that landed there.

## Backups

Everything is in Postgres. There is no second store, no object bucket, no cache that holds the
only copy of anything.

```bash
docker compose -f docker-compose.prod.yml exec -T postgres \
  pg_dump -U switchboard -Fc switchboard > switchboard-$(date +%F).dump
```

The event tables dominate the size and are the least valuable part — they are telemetry, and
retention is already deleting them on a schedule. `pg_dump --exclude-table-data='eval_events*'
--exclude-table-data='metric_events*'` gives a much smaller dump that still restores every flag,
every version snapshot and every audit row. Which of the two you want depends on whether you would
rather lose rollout history or pay to keep it.

**Test the restore.** A backup nobody has restored is a hypothesis.

## Scaling past one node

In rough order of when each becomes the thing that hurts:

1. **Divide the rate limits by the instance count** (see above), or accept the drift.
2. **Move migrations out of boot** (see above).
3. **Postgres connection pool.** `spring.r2dbc.pool.max-size` is 10 per instance; the sum across
   instances must stay under the server's `max_connections`, with headroom for the JDBC
   connections Flyway takes and for `psql`.
4. **`LISTEN` connections.** Each instance holds one dedicated connection for change
   notifications, and it is not from the pool.
5. **Redis**, if and only if step 1's answer stops being good enough.

## The container images

| | |
|---|---|
| `backend/Dockerfile` | JDK 25 build → JRE 25 runtime, layered jar, non-root uid 1001. No Maven, no source and no compiler in the runtime image. |
| `dashboard/Dockerfile` | Vite build → `nginx-unprivileged` on 8080, uid 101. Runs under a read-only root filesystem and a restricted pod security context without modification. |

Both declare `HEALTHCHECK`s that ask for something real — the backend's readiness endpoint, the
dashboard's actual `index.html` — rather than proving a port is open. An image whose `dist/` never
got copied passes the second kind of check.

**Build contexts differ.** The backend image builds from the **repository root**
(`docker build -f backend/Dockerfile .`), because it compiles against the sibling `evaluation/`
module; the dashboard builds from `dashboard/`. `docker-compose.prod.yml` already sets both.

## Verifying a deployment

**The [live check scripts](development.md#the-live-checks) do not work against a deployment**, and
it is worth saying why rather than letting someone find out by running one. Every one of them
authenticates with `Bearer dev:<email>`, which exists only under the `local` profile. Against a
real environment they fail with 401 on the first call — which is the correct behaviour of the
deployment, not a fault in the check. They belong in [CI](../.github/workflows/ci.yml), where the
stack is local by construction, and they run there on every pull request.

What is left for a deployment is short and worth doing every time:

```bash
# 1. Ready, from inside the network — the management port is not published.
docker compose -f docker-compose.prod.yml exec -T backend \
  curl -fsS http://localhost:28081/actuator/health/readiness

# 2. Migrations reached the expected version.
docker compose -f docker-compose.prod.yml exec -T postgres \
  psql -U switchboard -d switchboard -c \
  'select version, success from flyway_schema_history order by installed_rank desc limit 1'

# 3. The dashboard's runtime config is the one you meant to deploy. This is the check that
#    catches VITE_API_BASE_URL pointing at the container instead of at the browser's world.
curl -fsS https://switchboard.example.com/config.js
```

Then sign in and toggle a flag. Evaluation, the write path, the audit trail and delivery are all
on that one path, and nothing automated here substitutes for it.
