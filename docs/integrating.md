# Integrating

Evaluating flags from your code, reporting outcomes back, and gating AI agents.

Companions: [architecture.md](architecture.md) for how delivery works,
[targeting.md](targeting.md) for what you can target on.

---

## The smallest thing that works

Evaluate against an environment's SDK key. No client library required — it is one POST.

```js
const res = await fetch('http://localhost:28080/api/eval/new-checkout', {
  method: 'POST',
  headers: { Authorization: `Bearer ${SDK_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    context: { key: userId, attributes: { plan: 'pro', platform: 'ios' } },
    default: 'false',            // served back if the flag is unknown — always safe
  }),
});
const { value, reason } = await res.json();   // e.g. { value: "true", reason: "ROLLOUT" }
```

## OpenFeature / OFREP

Switchboard implements [OFREP](https://github.com/open-feature/protocol), so the
OpenFeature-maintained providers for Go, Python, .NET, Java, and JavaScript work against it with no
Switchboard-specific code:

| Endpoint | What it does |
|---|---|
| `POST /ofrep/v1/evaluate/flags/{key}` | One flag, evaluated server-side |
| `POST /ofrep/v1/evaluate/flags` | Every flag for a context, with ETag/304 |
| `GET /ofrep/v1/stream` | `refetchEvaluation` events on change |

Authenticated by SDK key via either `Authorization: Bearer` or `X-API-Key`.

For TypeScript, [`sdk/typescript`](../sdk/typescript/README.md) is a first-party provider that
evaluates **locally** — it holds the rule set in memory, so a flag check after the initial load
costs nothing and does not touch the network.

## The native evaluation surface

| Endpoint | What it does |
|---|---|
| `POST /api/eval/{key}` | One flag |
| `POST /api/eval` | Every flag at once, for a context |
| `GET /api/eval/bootstrap` | The whole environment payload, with an `ETag` |
| `GET /api/stream` | SSE: a `put` on connect, a `patch` per change, `ping` every 15s |

Send `If-None-Match` on the bootstrap and you get a 304 when nothing changed. Changes propagate
through Postgres `NOTIFY`, so every backend instance sees them without instance-to-instance
coupling.

## Client-side keys

A key that ships inside a browser bundle is public: anyone who can read your JavaScript can read
the key. So a **client key** (`sb_cli_`) gets a deliberately smaller surface than a server key
(`sb_srv_`).

| | Server key | Client key |
|---|---|---|
| `GET /api/eval/bootstrap` | Full rule set | **403** — use the POST |
| `POST /api/eval/bootstrap` | Evaluated values | Evaluated values |
| `POST /api/eval`, `/api/eval/{key}`, OFREP | Every flag | Only client-available flags |
| `GET /api/stream` | `put` / `patch` with config | `refetch` signals only |
| `POST /api/events/eval` | Yes | Yes |
| `POST /api/events/metrics` | Yes | **403** |

Client payloads carry the **served variation only** — no targeting rules, no segment membership, and
not even the values of the arms that were not served.

A flag is invisible to client keys until you mark it **available to client-side SDKs** on its
settings tab. That is off by default, so a brand-new client integration returns an empty flag list
until you publish something to it — which looks like a broken integration and is not.

```js
const res = await fetch('http://localhost:28080/api/eval/bootstrap', {
  method: 'POST',
  headers: { Authorization: `Bearer ${CLIENT_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ context: { key: userId, attributes: { plan: 'pro' } } }),
});
const { flags, contextHash } = await res.json();
// flags: [{ key, kind, value, variationId, variationName, reason, ruleId, version }]
```

The response carries an `ETag` you can send back as `If-None-Match` for a bodiless 304. Note it
digests the **body**, not the environment version — the payload depends on your context, so a
version-based ETag would let a shared cache serve one user's flags to another. Discard any response
whose `contextHash` does not match the context you sent; it is the guard against applying a 304
across a context change.

Metric events are refused from a client key on purpose: they feed the automated rollback loop, so
accepting them from a public key would be accepting unauthenticated flag changes. Report them from
your server.

## Reporting outcomes

The AI layer can only judge what it can see. Report metric events so healing and optimizing have
something to work from:

```js
await fetch('http://localhost:28080/api/events/metrics', {
  method: 'POST',
  headers: { Authorization: `Bearer ${SDK_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ events: [{ contextKey: userId, metricKey: 'error', value: 1,
                                    occurredAt: new Date().toISOString() }] }),
});
```

The `contextKey` must be the same key you evaluated with — that is how a metric is attributed to the
variation the subject actually saw. Rates are computed per **distinct subject**, not per event, so
reporting an error on each of a hot loop's iterations does not make one unhappy user look like a
thousand.

## Gating AI agents

Flag contexts carry arbitrary attributes, which makes an agent run a first-class subject. Use the
run id as the context key and describe the run in attributes:

```js
const { value: promptVariant } = await evaluate('agent-planner-prompt', {
  key: runId,
  attributes: { agent: 'meal-planner', version: 'v3', plan: 'pro' },
});
// promptVariant === 'prompt-v1' | 'prompt-v2'
```

Now a prompt revision, a tool, or an entire sub-behaviour is a multivariate flag: split agent traffic
50/50, report `error` and `conversion` events per run, and the rollout monitor compares the variants
for you — rolling back a prompt that starts failing and ramping one that measurably does better.
Because targeting reads attributes, you can scope an experiment to one agent
(`agent EQUALS meal-planner`) while everything else stays on the baseline.

The seeded `agent-planner-prompt` flag is a working example of exactly this.
