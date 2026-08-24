# Switchboard backend

The whole API: management, evaluation, streaming, governance, and the AI layer. Spring Boot
(WebFlux, R2DBC, Flyway) on Java 25, backed by one Postgres and Firebase for identity. There is
no broker and no cache tier — change propagation between instances rides Postgres `NOTIFY`.

Every UI is a consumer of this API, so anything a screen can do is reachable with curl. The
[walkthrough](#the-walkthrough) below is that claim, executed.

## Running it

From the repo root:

```bash
make deps-up     # postgres 18 on 25432 + firebase auth emulator on 29099
make backend     # spring boot on 28080, local profile
make seed        # demo org, project, flags, SDK keys (optional; the walkthrough does not need it)
```

`make backend` is a thin wrapper, and it is worth knowing what it wraps:

```bash
cd backend && JAVA_HOME=$(/usr/libexec/java_home -v 25) FIREBASE_AUTH_EMULATOR_HOST=localhost:29099 \
  ./mvnw spring-boot:run -Dspring-boot.run.profiles=local -Dcheckstyle.skip
```

Three parts of that line are load-bearing:

- **`JAVA_HOME`** — the build targets Java 25 (`<java.version>25</java.version>`, Spring Boot
  4.1). The shell default is whatever jenv resolves and is not guaranteed to be 25, so every
  Maven invocation in the Makefile goes through `scripts/resolve-java.sh` instead of trusting it.
- **`FIREBASE_AUTH_EMULATOR_HOST`** — without it the Firebase Admin SDK verifies emulator
  tokens against real Google and rejects **every** real login with a 401, while dev tokens keep
  working. See [Gotchas](#gotchas).
- **`-Dcheckstyle.skip`** — checkstyle is bound to the `validate` phase, so it runs ahead of
  every Maven goal including `spring-boot:run`. Skipping it keeps restarts fast; `make check`
  is where it is enforced.

Ports: backend **28080**, postgres **25432**, auth emulator **29099**. Health is at
`GET /actuator/health` (`health`, `info` and `metrics` are the only exposed actuator endpoints).

### Profiles

There are two, `default` and `local`. `local` (`application-local.yml`) changes exactly three
things: it turns on dev-token authentication, sets the job shared secret to `local-job-token`,
and raises `com.switchboard` logging to DEBUG. Everything else — ports, datasource, Flyway —
comes from `application.yml` and its environment defaults.

| Variable | Default | Notes |
| --- | --- | --- |
| `DB_HOST` / `DB_PORT` / `DB_NAME` | `localhost` / `25432` / `switchboard` | Feeds both the R2DBC URL and the Flyway JDBC URL |
| `DB_USER` / `DB_PASSWORD` | `postgres` / `postgres` | |
| `SERVER_PORT` | `28080` | |
| `FLYWAY_ENABLED` | `true` | |
| `FIREBASE_PROJECT_ID` | `demo-switchboard` | Must match the emulator's project |
| `FIREBASE_AUTH_EMULATOR_HOST` | unset | `localhost:29099` locally. Read from the OS environment, not from config |
| `ANTHROPIC_API_KEY` | empty | Empty selects the keyless assistant; AI drafting then returns `503 AI_UNAVAILABLE` and everything else still works |
| `JOB_TOKEN` | empty | Shared secret for `/api/jobs/**`. Empty refuses every call — these endpoints fail closed |
| `JOBS_SCHEDULED_ENABLED` | `true` | The hourly in-process scan; a real scheduler should drive the endpoints instead |

### Migrations

Flyway runs at startup against `classpath:db/migration` and there is no separate migrate step.
The current head is **V3** (`V1__baseline.sql`, `V2__scoped_rbac_and_change_requests.sql`,
`V3__ai_proposal_change_requests.sql`), and boot logs it:

```
o.f.core.internal.command.DbMigrate : Current version of schema "public": 3
```

Schema is plain SQL. There are no Spring Data entities anywhere in this codebase — no `@Table`,
no `R2dbcRepository` — so a migration is the only place the shape of a table is written down.

## Architecture

Four layers, and the dependency rule points inward.

```
domain/         pure Java. Records, enums, port interfaces, FlagEvaluator. Zero Spring imports.
application/    services that compose ports inside a TransactionalOperator boundary.
infrastructure/ adapters: DatabaseClient SQL, pg_notify, Firebase, the Claude assistant.
interfaces/     REST controllers implementing generated OpenAPI interfaces, plus security.
```

**`domain/`** carries no framework at all — `grep -r org.springframework domain/` returns
nothing, and that is a rule rather than an accident. `domain/flag`, `domain/segment`,
`domain/project`, `domain/org`, `domain/user`, `domain/access`, `domain/changerequest` and
`domain/ai` hold the records; each also declares its repository *interface*
(`FlagRepository`, `AccessRepository`, `ChangeRequestRepository`, …), which is the port the
application layer talks to. `domain/evaluation/FlagEvaluator` is a static, side-effect-free
function of (flag, config, context, segments) and is the reference implementation the spec
describes.

**`application/`** is where transactions live. `FlagTargetingService`, `ChangeRequestService`,
`ProposalService`, `FlagService`, `SegmentService` and friends are `@Service` beans that
compose domain ports and wrap the composition with `TransactionalOperator` — `.as(tx::transactional)`
on the reactive chain, never `@Transactional`, because the boundary has to be a property of the
pipeline rather than of the method. `EnvSnapshotCache` also lives here: an explicit Caffeine
`AsyncCache` rather than `@Cacheable`, because `@Cacheable` over a `Mono` caches the publisher
instead of the value.

**`infrastructure/persistence/adapter/`** implements the ports with `DatabaseClient` and
hand-written SQL. Thirteen adapters, one per aggregate, each mapping rows to domain records by
hand. `infrastructure/notify` is the cross-instance propagation pair, `infrastructure/firebase`
builds the Admin SDK bean, and `infrastructure/ai` chooses between the Claude adapter and a
no-op from configuration alone.

**`interfaces/rest/`** controllers are thin: resolve the principal, call one application
service, map the result. They implement generated interfaces (`FlagsApi`, `EvaluationApi`,
`AuditApi`, …) and every response shape is built by a static mapper class
(`FlagMappers`, `AiMappers`, `GovernanceMappers`, `TopologyMappers`) that holds no state and
does no I/O. `interfaces/error/GlobalExceptionHandler` turns the five domain exceptions into
the `{ error, message }` envelope — `NotFoundException` → 404 `NOT_FOUND`, `ForbiddenException`
→ 403, `ConflictException` → 409, `ValidationException` → 400, `AiUnavailableException` → 503.

### Two contracts, both enforced

**The wire** is `src/main/resources/openapi/switchboard-api.yaml`. The openapi-generator plugin
turns it into reactive, interface-only Spring server interfaces under
`target/generated-sources/openapi` (`com.switchboard.interfaces.rest.api` for operations,
`...rest.model` for schemas) with `skipDefaultInterface`, so an operation nobody implements is
a compile error rather than a 404 discovered later. The dashboard generates its TypeScript
types from the same file.

Three endpoints are hand-bound instead, all for the same reason — a generated signature is
fixed to one response type and these have more than one:

- `StreamController` (`GET /api/stream`) returns an infinite `Flux<ServerSentEvent>`.
- `OfrepController` answers one operation with three body schemas (success,
  `evaluationFailure`, `flagNotFound`) and the bulk operation with a body or a bodiless 304.
- `OfrepStreamController` is SSE for the same reason as the first.

Their paths, schemas and security schemes are still declared in the YAML; only the binding is
by hand.

**The behavior** is [`spec/evaluation.md`](../spec/README.md) plus 201 conformance vectors in
`spec/conformance/`. `ConformanceVectorTest` loads every vector file and asserts `FlagEvaluator`
matches, which is what stops the server and an SDK from disagreeing about which half of a
rollout a context lands in. Any change to evaluation behavior lands as a spec change plus
regenerated vectors in the same commit — the spec README is explicit about this and it is the
one rule in this repo worth treating as absolute.

## The patterns a newcomer will trip over

### The versioned write path

Every mutation of a flag's configuration in an environment goes through
`FlagTargetingService.mutate`, and it always does the same six things:

```
SELECT ... FOR UPDATE on the head row      (flags.lockHead)
  check expectedVersion against head       (409 CONFLICT if stale)
  validate variation ids + segment keys    (400 VALIDATION_FAILED)
  UPDATE head        -> version + 1
  INSERT snapshot    -> flag_env_config_versions
  INSERT audit row   -> audit_entries
  UPDATE environments.state_version        (the environment's change cursor)
------------------------------------------ commit
  invalidate the local snapshot cache, then pg_notify('flag_change', ...)
```

The `FOR UPDATE` is the whole concurrency story. Without it two writers read the same head and
compute the same next version, and the unique index on
`(flag_id, environment_id, version_number)` starts rejecting writes. `FlagUpdateRaceIT` fires
twenty concurrent kill-switch writes at one flag and asserts the version chain comes out gapless.

The `pg_notify` happens **after** commit, in a `doOnNext` attached outside the transactional
boundary, and it is fire-and-forget: a failed NOTIFY is logged and swallowed, because the write
it describes has already committed and there is nothing useful to roll back.

Two deliberate asymmetries:

- **The kill switch ignores `expectedVersion`.** An emergency stop that can be refused because
  somebody else edited the flag first is not an emergency stop.
- **Rollback writes a new version.** `rollback(toVersion)` reads the old snapshot and writes its
  contents as version `head + 1`. History is append-only; nothing is ever rewound, so the
  rollback is itself rollback-able and the audit log stays a true record of what was live when.

`WriteOrigin` stamps each snapshot with what caused it — nothing for a hand edit, a proposal id
for an AI apply, a change-request id for an approved review. Partial unique indexes on those two
columns make a second apply of the same proposal or request fail at the database, which is the
backstop behind each caller's status compare-and-set when two instances race
(`ProposalDoubleApplyRaceIT`, `ChangeRequestApprovalRaceIT`).

### Change propagation is Postgres, not Redis

`FlagChangePublisher.publish` evicts this instance's snapshot cache and fires
`pg_notify('flag_change', '<envId>:<flagKey>:<stateVersion>')`. `PgNotifyListener` LISTENs on
that channel in every instance, evicts its own cache, and pushes the changed flag key into
`EnvironmentStreamHub`, which fans it out to the SSE subscribers for that environment. An empty
flag key means "something changed with no single-flag scope" (a create, an archive, a segment
edit) and only evicts.

Two details of the listener matter:

- It holds a **dedicated `PostgresqlConnection` outside the R2DBC pool**. A pooled connection
  would be recycled out from under the LISTEN.
- It **merges a 30-second `SELECT 1` keepalive into the notification stream**, because that
  dedicated connection is otherwise idle between changes and gets reset by infrastructure idle
  timeouts. The whole pipeline retries forever with backoff (5s, capped at 2 minutes).

The result is that instances never talk to each other, and adding one costs nothing but a
connection.

### Three principals, one bearer header

`SwitchboardAuthenticationManager` routes the token by prefix:

| Token | Principal | Where it is allowed |
| --- | --- | --- |
| `sb_srv_…` | `SdkKeyPrincipal` (key, env, project, org) | SDK surface only: `/api/eval/**`, `/api/stream`, `/api/events/**`, `/ofrep/**` |
| `dev:<email>` | `AuthenticatedUser`, auto-provisioned | Management surface. Local profile only — any other profile answers 401 `Dev tokens are disabled` |
| anything else | `AuthenticatedUser` from a verified Firebase ID token | Management surface |

The split is enforced in `SecurityConfig` by role (`ROLE_SDK` vs `ROLE_USER`), so a user token
on `/api/eval` is a 403 and an SDK key on `/api/projects/...` is a 403 — both are proved in
`scripts/smoke-test.mjs`. SDK keys are stored as SHA-256 hashes and the full key is returned
exactly once, at creation.

`X-API-Key` is accepted as a second carrier because OFREP defines that scheme and OpenFeature
providers pick either. It is deliberately restricted to values starting `sb_srv_`: a user
credential arriving through a second door would widen the management surface for no caller that
exists, and a non-SDK value simply is not a credential there, which the filter chain turns into
a 401 rather than a misleading 403.

`/api/jobs/**` is outside the bearer chain entirely (a scheduler has no user) and authenticates
with a constant-time comparison against the `X-Job-Token` shared secret.

### Scoped RBAC with union semantics

Roles are granted at ORG, PROJECT or ENVIRONMENT scope, and a caller's effective permissions at
a scope are the **union** of what they hold there and at every wider scope containing it. A
narrow grant adds capability; it never removes any. `OrgAccessService` is the single gate every
controller and service funnels through, and each call site names the permission it needs
(`FLAG_WRITE`, `FLAG_KILL`, `FLAG_ROLLBACK`, `APPROVE_CHANGES`, `MANAGE_SDK_KEYS`, …).

Permissions are **code** — an enum, because something has to enforce each one. Roles are
**data**, rows in `roles` + `role_permissions`, so adding a role is an INSERT. `role_permissions`
carries no CHECK constraint on purpose and `Permission.parseOrNull` ignores names the running
binary does not know, so a row written by a newer release does not crash an older one.

Error shapes are chosen, not incidental: a scope that does not exist is 403 for an org
(existence is never leaked) and 404 for a project or environment; a caller with no standing in
the org is 403; a member missing one permission is 403 naming the permission.

### 202 means "nothing was written"

An environment can require approval. When it does, `ChangeRequestService` does not perform the
write — it opens a PENDING change request and the endpoint answers **202 Accepted** with that
request plus a `Location` header, instead of **200 OK** with a new config version. `WriteOutcome`
is the sealed type behind that fork, so the two cases cannot drift apart.

The gate costs one environment lookup when approval is off, and nothing is persisted on that
path. A stale author gets the same 409 a direct write would have given, raised before the
request is opened, so nobody sits through a review cycle to be told their base version moved.

Two exemptions, both configurable and both fully audited: the kill switch bypasses review
unless `requireApprovalForKill` is explicitly turned on, and automated healing bypasses it
while `allowAutomationBypass` is on (it defaults to on, and only means anything when approval is
on at all). A human applying an AI proposal is gated exactly like that human's hand edit.

## The walkthrough

Every command below was run against a local backend and every response is its real output. It
needs `make deps-up` and `make backend`, plus `jq`. It does not need `make seed` — step 1 creates
the user and the rest builds a workspace from nothing.

```bash
API=http://localhost:28080
AUTH="Authorization: Bearer dev:frank@switchboard.dev"
```

**1. Sign in.** `GET /api/users/me` auto-provisions the dev-token user on first call, so this is
both "who am I" and "create me".

```bash
curl -s $API/api/users/me -H "$AUTH" | jq .
```

```json
{
  "id": "3f733258-2734-46c9-a2ae-a02e5885b872",
  "email": "frank@switchboard.dev",
  "onboardingCompleted": true,
  "memberships": []
}
```

**2. Create an org.** Whoever creates it is its OWNER.

```bash
ORG_JSON=$(curl -s -X POST $API/api/orgs -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Frank Labs"}')
echo "$ORG_JSON" | jq .
ORG=$(echo "$ORG_JSON" | jq -r .id)
```

```json
{
  "id": "b5c70f19-b5a7-4033-9571-70fed532f8cf",
  "name": "Frank Labs",
  "slug": "frank-labs",
  "role": "OWNER",
  "createdAt": "2026-08-24T22:41:48.546345Z"
}
```

**3. Create a project.** `dev`, `staging` and `production` are seeded with it in the same
transaction, each with approvals off and a `stateVersion` of 0.

```bash
PROJECT_JSON=$(curl -s -X POST $API/api/orgs/$ORG/projects -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"key":"web","name":"Web"}')
echo "$PROJECT_JSON" | jq '{id, key, environments: [.environments[]
  | {key, name, stateVersion, requireApproval: .approvals.requireApproval}]}'
PROJECT=$(echo "$PROJECT_JSON" | jq -r .id)
PROD_ENV=$(echo "$PROJECT_JSON" | jq -r '.environments[] | select(.key=="production") | .id')
```

```json
{
  "id": "1b6dd5ad-cd4c-4636-9604-85c251f01d78",
  "key": "web",
  "environments": [
    { "key": "dev",        "name": "Development", "stateVersion": 0, "requireApproval": false },
    { "key": "staging",    "name": "Staging",     "stateVersion": 0, "requireApproval": false },
    { "key": "production", "name": "Production",  "stateVersion": 0, "requireApproval": false }
  ]
}
```

**4. Mint an SDK key.** Keys are per environment. The full key comes back **once** and is stored
only as a SHA-256 hash — the list endpoint returns `keyPrefix` and never the key itself.

```bash
KEY_JSON=$(curl -s -X POST $API/api/environments/$PROD_ENV/sdk-keys \
  -H "$AUTH" -H 'Content-Type: application/json' -d '{"label":"production server"}')
echo "$KEY_JSON" | jq .
SDK_KEY=$(echo "$KEY_JSON" | jq -r .key)
```

```json
{
  "id": "a0b642b9-8655-48e6-aef1-b1fd861228a2",
  "environmentId": "e06e615b-b46e-444a-b4f6-67b75fe847ca",
  "key": "sb_srv_production_bd70ba3d5e49e4879ba1dd080ea3dfd2",
  "keyPrefix": "sb_srv_produ…",
  "createdAt": "2026-08-24T22:41:48.620393Z",
  "label": "production server"
}
```

**5. Create a flag.** A BOOLEAN flag gets its two variations for free, and every environment gets
a v1 config: disabled, serving the fallthrough.

```bash
FLAG=$(curl -s -X POST $API/api/projects/$PROJECT/flags -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"key":"new-checkout","name":"New checkout","kind":"BOOLEAN"}')
echo "$FLAG" | jq '{key, kind, variations, envConfigs: [.envConfigs[] | {envKey, enabled, version}]}'
ON=$(echo  "$FLAG" | jq -r '.variations[] | select(.value=="true")  | .id')
OFF=$(echo "$FLAG" | jq -r '.variations[] | select(.value=="false") | .id')
```

```json
{
  "key": "new-checkout",
  "kind": "BOOLEAN",
  "variations": [
    { "id": "f710e0d1-7b17-4422-842f-bd853024a808", "value": "true",  "name": "True" },
    { "id": "bde8de4d-3342-4bdc-8d31-4e90d0849077", "value": "false", "name": "False" }
  ],
  "envConfigs": [
    { "envKey": "dev",        "enabled": false, "version": 1 },
    { "envKey": "production", "enabled": false, "version": 1 },
    { "envKey": "staging",    "enabled": false, "version": 1 }
  ]
}
```

**6. Turn it on at 25% in production.** One PUT carries the whole config; `expectedVersion` is the
optimistic-concurrency guard.

```bash
curl -s -X PUT $API/api/projects/$PROJECT/flags/new-checkout/environments/production \
  -H "$AUTH" -H 'Content-Type: application/json' -d "{
    \"enabled\": true,
    \"expectedVersion\": 1,
    \"comment\": \"ramp to 25%\",
    \"config\": {
      \"fallthrough\": { \"rollout\": [ { \"variationId\": \"$ON\",  \"weight\": 25 },
                                        { \"variationId\": \"$OFF\", \"weight\": 75 } ] },
      \"offVariationId\": \"$OFF\",
      \"defaultVariationId\": \"$ON\",
      \"individualTargets\": [],
      \"rules\": []
    }
  }" | jq '{version, enabled, killSwitchActive, fallthrough: .config.fallthrough}'
```

```json
{
  "version": 2,
  "enabled": true,
  "killSwitchActive": false,
  "fallthrough": {
    "rollout": [
      { "variationId": "f710e0d1-7b17-4422-842f-bd853024a808", "weight": 25 },
      { "variationId": "bde8de4d-3342-4bdc-8d31-4e90d0849077", "weight": 75 }
    ]
  }
}
```

**7. Evaluate it with the SDK key.** Two contexts, landing on opposite sides of the 25% line.
Nothing in the request names an environment: the key *is* the environment.

```bash
for CTX in user-12 user-1; do
  curl -s -X POST $API/api/eval/new-checkout -H "Authorization: Bearer $SDK_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"context\":{\"key\":\"$CTX\"},\"default\":\"false\"}" | jq -c .
done
```

```json
{"flagKey":"new-checkout","value":"true","reason":"ROLLOUT","flagVersion":2,"variationId":"f710e0d1-7b17-4422-842f-bd853024a808"}
{"flagKey":"new-checkout","value":"false","reason":"ROLLOUT","flagVersion":2,"variationId":"bde8de4d-3342-4bdc-8d31-4e90d0849077"}
```

`user-12` hashes to bucket 104 of 10000 and `user-1` to 5977. At 25% the first 2500 buckets serve
`true`, so the first line is `user-12` and the second is `user-1`.

**8. Widen to 50%, and watch what does not happen.**

```bash
curl -s -X PUT $API/api/projects/$PROJECT/flags/new-checkout/environments/production \
  -H "$AUTH" -H 'Content-Type: application/json' -d "{
    \"enabled\": true, \"expectedVersion\": 2, \"comment\": \"ramp to 50%\",
    \"config\": {
      \"fallthrough\": { \"rollout\": [ { \"variationId\": \"$ON\",  \"weight\": 50 },
                                        { \"variationId\": \"$OFF\", \"weight\": 50 } ] },
      \"offVariationId\": \"$OFF\", \"defaultVariationId\": \"$ON\",
      \"individualTargets\": [], \"rules\": []
    }
  }" | jq -c '{version, rollout: [.config.fallthrough.rollout[].weight]}'

for CTX in user-12 user-5 user-1; do
  curl -s -X POST $API/api/eval/new-checkout -H "Authorization: Bearer $SDK_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"context\":{\"key\":\"$CTX\"},\"default\":\"false\"}" | jq -c .
done
```

```json
{"version":3,"rollout":[50,50]}
{"flagKey":"new-checkout","value":"true","reason":"ROLLOUT","flagVersion":3,"variationId":"f710e0d1-7b17-4422-842f-bd853024a808"}
{"flagKey":"new-checkout","value":"true","reason":"ROLLOUT","flagVersion":3,"variationId":"f710e0d1-7b17-4422-842f-bd853024a808"}
{"flagKey":"new-checkout","value":"false","reason":"ROLLOUT","flagVersion":3,"variationId":"bde8de4d-3342-4bdc-8d31-4e90d0849077"}
```

`user-12` (bucket 104) was in and is still in. `user-5` (bucket 3340) has joined. `user-1`
(bucket 5977) is still out. Bucketing is `md5(flagKey + ":" + contextKey)` and the window only
grows from zero, so widening a ramp adds contexts and never reshuffles them — the reason a user
who saw the new checkout at 25% does not lose it at 50%.

**9. A stale write is refused, not merged.**

```bash
curl -s -w '\nHTTP %{http_code}\n' -X PUT \
  $API/api/projects/$PROJECT/flags/new-checkout/environments/production \
  -H "$AUTH" -H 'Content-Type: application/json' -d "{
    \"enabled\": true, \"expectedVersion\": 2,
    \"config\": { \"fallthrough\": { \"variationId\": \"$ON\" },
                  \"offVariationId\": \"$OFF\", \"defaultVariationId\": \"$ON\",
                  \"individualTargets\": [], \"rules\": [] } }"
```

```
{"error":"CONFLICT","message":"Version conflict: expected v2 but head is v3"}
HTTP 409
```

**10. Pull the kill switch.** It takes no `expectedVersion` and needs one round trip.

```bash
curl -s -X POST $API/api/projects/$PROJECT/flags/new-checkout/environments/production/kill-switch \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"active":true,"reason":"checkout 500s in production"}' \
  | jq -c '{version, enabled, killSwitchActive}'

curl -s -X POST $API/api/eval/new-checkout -H "Authorization: Bearer $SDK_KEY" \
  -H 'Content-Type: application/json' -d '{"context":{"key":"user-12"},"default":"false"}' | jq -c .
```

```json
{"version":4,"enabled":true,"killSwitchActive":true}
{"flagKey":"new-checkout","value":"false","reason":"KILL_SWITCH","flagVersion":4,"variationId":"bde8de4d-3342-4bdc-8d31-4e90d0849077"}
```

`enabled` is still `true`. The kill switch sits *above* it in the precedence ladder rather than
overwriting it, so switching it back off restores the ramp exactly as it was.

**11. Roll back, and get a NEW version.**

```bash
curl -s -X POST $API/api/projects/$PROJECT/flags/new-checkout/environments/production/rollback \
  -H "$AUTH" -H 'Content-Type: application/json' \
  -d '{"toVersion":2,"reason":"fix shipped, resume the ramp"}' \
  | jq -c '{version, enabled, killSwitchActive, rollout: [.config.fallthrough.rollout[].weight]}'

for CTX in user-12 user-5; do
  curl -s -X POST $API/api/eval/new-checkout -H "Authorization: Bearer $SDK_KEY" \
    -H 'Content-Type: application/json' \
    -d "{\"context\":{\"key\":\"$CTX\"},\"default\":\"false\"}" | jq -c .
done
```

```json
{"version":5,"enabled":true,"killSwitchActive":false,"rollout":[25,75]}
{"flagKey":"new-checkout","value":"true","reason":"ROLLOUT","flagVersion":5,"variationId":"f710e0d1-7b17-4422-842f-bd853024a808"}
{"flagKey":"new-checkout","value":"false","reason":"ROLLOUT","flagVersion":5,"variationId":"bde8de4d-3342-4bdc-8d31-4e90d0849077"}
```

Rolling back to v2 produced **v5**, not a return to v2. The old snapshot was re-applied as a new
version, the kill switch came off with it because v2 had it off, and `user-5` is outside the 25%
window again.

**12. Read the history.**

```bash
curl -s "$API/api/projects/$PROJECT/flags/new-checkout/environments/production/versions" -H "$AUTH" \
  | jq -c '.items[] | {versionNumber, enabled, killSwitchActive, versionNote}'
```

```json
{"versionNumber":5,"enabled":true,"killSwitchActive":false,"versionNote":"rollback to v2"}
{"versionNumber":4,"enabled":true,"killSwitchActive":true,"versionNote":"kill switch on"}
{"versionNumber":3,"enabled":true,"killSwitchActive":false,"versionNote":"ramp to 50%"}
{"versionNumber":2,"enabled":true,"killSwitchActive":false,"versionNote":"ramp to 25%"}
{"versionNumber":1,"enabled":false,"killSwitchActive":false,"versionNote":"flag created"}
```

Five versions for five writes, newest first, nothing rewritten.

**13. Read the audit trail.** The same events from the governance side: who, why, and which
version range each write moved.

```bash
curl -s "$API/api/projects/$PROJECT/audit?limit=6" -H "$AUTH" \
  | jq -c '.items[] | {action, flagKey, envKey, actor, versionFrom, versionTo, reason}'
```

```json
{"action":"ROLLBACK","flagKey":"new-checkout","envKey":"production","actor":"frank@switchboard.dev","versionFrom":4,"versionTo":5,"reason":"fix shipped, resume the ramp"}
{"action":"KILL_SWITCH_ON","flagKey":"new-checkout","envKey":"production","actor":"frank@switchboard.dev","versionFrom":3,"versionTo":4,"reason":"checkout 500s in production"}
{"action":"UPDATE","flagKey":"new-checkout","envKey":"production","actor":"frank@switchboard.dev","versionFrom":2,"versionTo":3,"reason":"ramp to 50%"}
{"action":"UPDATE","flagKey":"new-checkout","envKey":"production","actor":"frank@switchboard.dev","versionFrom":1,"versionTo":2,"reason":"ramp to 25%"}
{"action":"CREATE","flagKey":"new-checkout","envKey":null,"actor":"frank@switchboard.dev","versionFrom":null,"versionTo":1,"reason":null}
{"action":"SDK_KEY_CREATE","flagKey":null,"envKey":"production","actor":"frank@switchboard.dev","versionFrom":null,"versionTo":null,"reason":null}
```

Minting the SDK key is in there too. The list is keyset-paged on `(createdAt, id)`; the response's
`nextCursor` is that pair, opaque.

**14. Evaluate the same flag through OFREP.** Same engine, OpenFeature's spelling — which is what
lets the OpenFeature-maintained providers talk to Switchboard with no Switchboard-specific code.

```bash
curl -s -X POST $API/ofrep/v1/evaluate/flags/new-checkout \
  -H "Authorization: Bearer $SDK_KEY" -H 'Content-Type: application/json' \
  -d '{"context":{"targetingKey":"user-12"}}' | jq .
```

```json
{
  "key": "new-checkout",
  "value": true,
  "reason": "SPLIT",
  "variant": "True",
  "metadata": {
    "switchboard.reason": "ROLLOUT",
    "switchboard.flagVersion": 5,
    "switchboard.flagKind": "BOOLEAN",
    "switchboard.variationId": "f710e0d1-7b17-4422-842f-bd853024a808"
  }
}
```

Three translations at once. `context.key` becomes `targetingKey`. `"true"` becomes a real JSON
boolean, because OFREP is typed while Switchboard stores every variation value as a string. And
`ROLLOUT` becomes `SPLIT`:

| Switchboard | OFREP |
| --- | --- |
| `KILL_SWITCH`, `FLAG_OFF` | `DISABLED` |
| `TARGET_MATCH`, `RULE_MATCH` | `TARGETING_MATCH` |
| `ROLLOUT` | `SPLIT` |
| `DEFAULT` | `STATIC` |

That mapping loses information, so nothing is dropped: the native reason, the config version, the
variation and (on a rule match) the rule id all survive in `metadata`.

**15. An unknown flag is where the two surfaces disagree, deliberately.**
`POST /api/eval/{key}` serves the caller's own `default` with reason `SDK_DEFAULT` and HTTP 200,
because an SDK on a hot path must never be handed an error. OFREP providers own their code default
and expect to be told the flag is missing:

```bash
curl -s -w '\nHTTP %{http_code}\n' -X POST $API/ofrep/v1/evaluate/flags/nope \
  -H "X-API-Key: $SDK_KEY" -H 'Content-Type: application/json' \
  -d '{"context":{"targetingKey":"user-12"}}'
```

```
{"key":"nope","errorCode":"FLAG_NOT_FOUND","errorDetails":"Flag 'nope' was not found in environment production"}
HTTP 404
```

That call used `X-API-Key` instead of `Authorization`, the other carrier OFREP defines. Same key,
same principal, same answers.

## Testing

```bash
make test    # from the repo root: ./mvnw verify
make check   # ./mvnw compile checkstyle:check
make smoke   # node scripts/smoke-test.mjs, against a running backend
```

`./mvnw verify` runs both halves and is the gate:

```
Tests run: 254, Failures: 0, Errors: 0, Skipped: 0     surefire  (unit)
Tests run:  66, Failures: 0, Errors: 0, Skipped: 0     failsafe  (integration)
BUILD SUCCESS
```

The split is by tag, not by directory: surefire runs with `excludedGroups=integration`, failsafe
with `groups=integration` and `**/*IT.java`, and `IntegrationTestBase` carries `@Tag("integration")`
so every subclass inherits it.

**The integration base is worth reading before you add a test to it.** One Postgres container
per JVM, started from a static initializer and reaped by Ryuk, but each test *class* gets its own
freshly created database on that container, registered through `@DynamicPropertySource` so Flyway
replays from empty. `@DirtiesContext` on the base class is what makes that work, and it is
load-bearing rather than hygiene: the context customizer's identity is the set of annotated
methods, which is the same inherited method for every subclass, so without the eviction all of
them would share one cached context and therefore one database. Delete that annotation and the
suite still passes for a while, then starts failing in ways that depend on class ordering.

Authentication in the suite uses the dev-token path, so tests exercise the real security filter
chain with no Firebase project; `FirebaseAuth` is mocked only because the production bean would
otherwise reach for application-default credentials at startup.

The three race tests are the ones that justify the write path's design, and each states what it
would catch:

- `FlagUpdateRaceIT` — 20 concurrent kill-switch writes must produce a gapless version chain.
  Kill-switch writes ignore `expectedVersion`, so every one of them must succeed, which leaves
  the `SELECT ... FOR UPDATE` as the only thing preventing two writers from computing the same
  next version.
- `ChangeRequestApprovalRaceIT` — 6 approvers hit a threshold of 2 simultaneously. Every review
  row must be counted (without `FOR UPDATE` on the request, two transactions under READ COMMITTED
  each see only their own review and the threshold is never crossed), and the crossing must apply
  exactly once.
- `ProposalDoubleApplyRaceIT` — 10 callers apply one DRAFT proposal at once. Exactly one wins,
  and a loser must leave no trace: no second snapshot carrying the proposal id, no second head
  bump, no second APPLIED stamp.

`ConformanceVectorTest` reports 202 tests: the 201 vectors plus the cross-file ramp-monotonicity
assertion that spans `ramp-at-10.json` and `ramp-at-25.json`.

`./mvnw -q compile checkstyle:check` is silent on success. Checkstyle is also bound to `validate`,
so it gates every other Maven goal too — which is why the run target passes `-Dcheckstyle.skip`.

`scripts/smoke-test.mjs` is the fastest honest answer to "is it working": ~35 cases end to end
against a running backend, negative paths included, driven entirely through the public API.

```
34 passed, 0 failed
```

It skips the AI drafting case with a note when no `ANTHROPIC_API_KEY` is configured, rather than
failing.

## Gotchas

**Java 25 or nothing.** `JAVA_HOME=$(/usr/libexec/java_home -v 25)` in front of every `mvnw`
invocation, which is exactly what `scripts/resolve-java.sh` returns. A jenv shim pinned to an
older JDK — globally or by a `.java-version` in a parent directory — makes the build fail during
compilation rather than at startup, which reads like a code problem and is not one.

**`FIREBASE_AUTH_EMULATOR_HOST=localhost:29099`, or real logins break silently.** The failure
mode is the reason this has its own section. Run the backend without it and:

```
dev token       -> HTTP 200
emulator token  -> HTTP 401
```

The app starts cleanly, logs nothing unusual, and every script and integration test that uses
`Bearer dev:<email>` keeps passing — while the dashboard and the mobile app, which sign in
through the emulator and send a real ID token, get a 401 on every request. The Admin SDK simply
verified an emulator-issued token against real Google. `make backend` sets the variable;
anything else you invent has to as well.

**No `timeout` on macOS.** The BSD userland has no `timeout(1)`, so `timeout 30 ./mvnw ...`
fails with "command not found" rather than doing anything useful. Use `curl --max-time`, or
background the process and poll.

**Checkstyle runs at `validate`.** Any Maven goal, including `spring-boot:run`, will fail on a
style violation before it does its own job. That is intentional, but it is surprising the first
time a formatting nit stops the server from starting.

**Generated sources are only regenerated when the spec changes.** The plugin runs with
`skipIfSpecIsUnchanged`, so `target/generated-sources/openapi` can hold models from an earlier
state of the YAML. If a compile error names a generated type whose shape looks wrong, clear
`target/` and rebuild before looking for the bug in source.

**Dev tokens are a local-profile capability.** `Bearer dev:<email>` auto-provisions a user and
authenticates as them, with no password anywhere. It is gated on
`switchboard.security.dev-auth-enabled`, which only `application-local.yml` sets. Deploying with
the `local` profile would be an open door.
