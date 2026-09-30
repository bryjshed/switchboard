# Integrating

Evaluating flags from your code, reporting outcomes back so the AI layer can judge a rollout,
and gating AI agents.

Companions: [getting-started.md](getting-started.md) for the end-to-end path,
[targeting.md](targeting.md) for what you can target on, [architecture.md](architecture.md) for
how delivery works.

Examples use `https://switchboard.example.com`. Substitute your instance's URL; every SDK
defaults to `http://localhost:28080`, the development stack, so production code must set it.

---

## Choosing how to integrate

| | Native SDK (Java, Node.js) | OFREP (any OpenFeature provider) | REST (any HTTP client) |
|---|---|---|---|
| Where evaluation happens | **In your process**, against rules held in memory | On the server | On the server |
| Cost of a flag check | A map lookup and a hash; no I/O | One HTTP round trip (bulk mode caches) | One HTTP round trip |
| During a Switchboard outage | Keeps serving the last rules it had | Serves your defaults | Serves your defaults |
| Context attributes leave your process | No | Yes | Yes |
| Records exposures for the AI layer | Yes, automatically | No — report them yourself | No — report them yourself |
| Languages | Java 25+, Node.js 18.17+ | Go, Python, .NET, Java, JavaScript, … | Anything |

Use a native SDK for server-side code in Java or Node.js. Use OFREP for other languages with an
OpenFeature provider. Use REST for anything else, or for a one-off script.

## Keys and where they come from

Every evaluation authenticates with an **SDK key** scoped to one environment. Create one under
**Settings → SDK keys** (pick the environment, **New key**), or with
`POST /api/environments/{envId}/sdk-keys`. The key is shown once.

- **Server key (`sb_srv_…`)** — for backend services. Receives the full rule set. Secret.
- **Client-side key (`sb_cli_…`)** — for code shipped to browsers. Public by design, with a
  deliberately smaller surface; see [Client-side keys](#client-side-keys).

Send it as `Authorization: Bearer <key>` (OFREP also accepts `X-API-Key`). A different
environment is a different key, so the same build promotes from staging to production by
changing only configuration.

## Java

Build the SDK from source first — [sdk/java/README.md](../sdk/java/README.md#install). Then,
through OpenFeature:

```java
var provider = new SwitchboardProvider(
    SwitchboardConfig.builder(System.getenv("SWITCHBOARD_SDK_KEY"))
        .baseUri("https://switchboard.example.com")
        .build());
OpenFeature.getInstance().setProviderAndWait(provider);

var client = OpenFeature.getInstance().getClient();
boolean on = client.getBooleanValue("new-checkout", false,
    new MutableContext(userId).add("plan", "pro"));
```

or directly, one dependency fewer:

```java
var switchboard = new SwitchboardClient(SwitchboardConfig.builder(sdkKey)
    .baseUri("https://switchboard.example.com").build());
switchboard.start();
boolean on = switchboard.booleanValue("new-checkout", false,
    EvalContexts.builder(userId).put("plan", "pro").build()).value();
```

In Spring Boot, make the client a singleton bean so it starts once and is closed — which flushes
buffered metrics — on shutdown:

```java
@Configuration
class SwitchboardConfiguration {

    @Bean(destroyMethod = "close")
    SwitchboardClient switchboard(@Value("${switchboard.sdk-key}") String sdkKey) {
        var client = new SwitchboardClient(SwitchboardConfig.builder(sdkKey)
            .baseUri("https://switchboard.example.com")
            .build());
        client.start();   // waits up to startTimeout (5s) for the first payload, then carries on
        return client;
    }
}
```

`start()` does not fail if Switchboard is unreachable: the client serves your defaults, retries in
the background, and reports `isReady() == false` for your health check.

## Node.js

Install the SDK from source first — [sdk/typescript/README.md](../sdk/typescript/README.md#install).

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { SwitchboardProvider } from '@switchboard/openfeature-provider';

await OpenFeature.setProviderAndWait(new SwitchboardProvider({
  sdkKey: process.env.SWITCHBOARD_SDK_KEY!,
  baseUrl: 'https://switchboard.example.com',
}));

const on = await OpenFeature.getClient()
  .getBooleanValue('new-checkout', false, { targetingKey: userId, plan: 'pro' });

// on shutdown, so buffered telemetry is sent:
await OpenFeature.close();
```

The Node.js SDK's local evaluation needs Node's `crypto` module, so it does not run in a browser.
For browser code, see [Client-side keys](#client-side-keys).

## OpenFeature via OFREP

Switchboard implements [OFREP](https://github.com/open-feature/protocol), so the
OpenFeature-maintained OFREP providers work against it with no Switchboard-specific code. Point
the provider at your instance's origin and pass the SDK key as a bearer token.

| Endpoint | What it does |
|---|---|
| `POST /ofrep/v1/evaluate/flags/{key}` | One flag, evaluated server-side |
| `POST /ofrep/v1/evaluate/flags` | Every flag for a context, with ETag/304 |
| `GET /ofrep/v1/stream` | `refetchEvaluation` events on change |

## REST

No client library required — it is one POST:

```js
const res = await fetch('https://switchboard.example.com/api/eval/new-checkout', {
  method: 'POST',
  headers: { Authorization: `Bearer ${SDK_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({
    context: { key: userId, attributes: { plan: 'pro', platform: 'ios' } },
    default: 'false',            // served back if the flag is unknown — always safe
  }),
});
const { value, reason, variationId } = await res.json();   // e.g. { value: "true", reason: "ROLLOUT", ... }
```

| Endpoint | What it does |
|---|---|
| `POST /api/eval/{key}` | One flag |
| `POST /api/eval` | Every flag at once, for a context |
| `GET /api/eval/bootstrap` | The whole environment payload, with an `ETag` (server keys only) |
| `GET /api/stream` | SSE: a `put` on connect, a `patch` per change, `ping` every 15s |

Send `If-None-Match` on the bootstrap and you get a 304 when nothing changed. An unknown flag key
returns your default at HTTP 200, never an error.

## The context

Every evaluation is for a **context**: a key plus attributes.

- **`key`** is required, and must be non-empty and not only whitespace. It is the bucketing input
  for percentage rollouts and the identity metrics are attributed to, so it must be **stable**
  for the subject: a user id, a tenant id, an agent run id. A blank key serves your default with
  `INVALID_CONTEXT`; the SDKs will not invent one.
- **Attributes** are typed: strings, numbers, booleans, or arrays of those. `null` and nested
  objects are treated as absent; nested arrays are flattened. Every operator matches an array
  existentially — `roles = ["admin","billing"]` matches `roles EQUALS admin`.
- The attribute name `key` is reserved: a clause on `key` reads the context key itself.
- Through OpenFeature, `targetingKey` is the key and every other field is an attribute.

The exact rules are [`spec/evaluation.md` §1.1 and §3.1](../spec/evaluation.md#1-inputs-and-outputs).

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

Client payloads carry the **served variation only** — no targeting rules, no segment membership,
and not even the values of the arms that were not served.

A flag is invisible to client keys until you mark it **available to client-side SDKs** on its
**Settings** tab. That is off by default, so a brand-new client integration returns an empty flag
list until you publish something to it — which looks like a broken integration and is not.

**In a browser today**, call the evaluated-bootstrap endpoint directly (below), or use
OpenFeature's web OFREP provider with the client key. The Node.js SDK does not run in a browser;
a browser build is on the [backlog](REMAINING-WORK.md).

```js
const res = await fetch('https://switchboard.example.com/api/eval/bootstrap', {
  method: 'POST',
  headers: { Authorization: `Bearer ${CLIENT_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ context: { key: userId, attributes: { plan: 'pro' } } }),
});
const { flags, contextHash } = await res.json();
// flags: [{ key, kind, value, variationId, variationName, reason, ruleId, version }]
```

The response carries an `ETag` you can send back as `If-None-Match` for a bodiless 304. It digests
the **body**, not the environment version — the payload depends on your context, so a
version-based ETag would let a shared cache serve one user's flags to another. Discard any
response whose `contextHash` does not match the context you sent.

Metric events are refused from a client key on purpose: they feed the automated rollback loop, so
accepting them from a public key would be accepting unauthenticated flag changes. Report them from
your server.

## Reporting outcomes

The AI layer compares variations by what happened to the subjects who received each one. It needs
two kinds of event, joined on the context key:

1. **Exposure (evaluation) events** — "context `user-42` was served variation X of
   `new-checkout`". These are what assign a subject to a variation.
2. **Metric events** — "context `user-42` hit `error`" or "converted".

A metric event for a context with no exposure event in the window is not attributed to any
variation, and so is invisible to the monitor.

| Integration | Exposures | Metrics |
|---|---|---|
| Node.js and Java SDKs | Sent automatically for every local evaluation | `switchboard.track(metricKey, contextKey[, value])` |
| OFREP, REST | Post them yourself (below) | Post them yourself (below) |

With a native SDK there is nothing to do but call `track()`: healing and optimizing work with
local evaluation. Turning the SDK's telemetry off (`telemetry: false` in Node.js,
`telemetryEnabled(false)` in Java) turns off both.

Server-side evaluation through `/api/eval` or OFREP records nothing by itself, so if you
integrate that way, **post exposures** from your server, with the `variationId` and `reason` the evaluation
returned:

```js
await fetch('https://switchboard.example.com/api/events/eval', {
  method: 'POST',
  headers: { Authorization: `Bearer ${SDK_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ events: [{ flagKey: 'new-checkout', contextKey: userId,
                                    variationId, reason, occurredAt: new Date().toISOString() }] }),
});
```

**Posting metrics** (server key only):

```js
await fetch('https://switchboard.example.com/api/events/metrics', {
  method: 'POST',
  headers: { Authorization: `Bearer ${SDK_KEY}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ events: [{ contextKey: userId, metricKey: 'error', value: 1,
                                    occurredAt: new Date().toISOString() }] }),
});
```

Both endpoints take up to 500 events per request and answer 202. Batch them; do not post one
request per evaluation.

**From the SDKs**, `track` enqueues and returns immediately; a background worker sends batches
every 10 seconds, and `close()` sends what is left:

```java
switchboard.track("conversion", userId);            // Java: value defaults to 1
switchboard.track("checkout.latency-ms", userId, 318);
```

```ts
switchboard.track('conversion', userId);            // Node.js
switchboard.track('checkout.latency-ms', userId, 318);
```

Through OpenFeature, `client.track("conversion", context)` routes to the same place in both SDKs;
the context's targeting key is required.

The `contextKey` must be the same key you evaluated with — that is the whole attribution.
Rates are computed per **distinct subject**, not per event, so reporting an error on each of a
hot loop's iterations does not make one unhappy user look like a thousand.

### Which metrics drive healing and optimizing

Any metric key is accepted and stored. The monitor acts only on the keys the **project has
defined**, each with a direction (is higher better or worse?) and a threshold worth reacting to.
Every project starts with two:

| Key | Direction | Reacts to an absolute difference of |
|---|---|---|
| `error` | lower is better | 1 percentage point |
| `conversion` | higher is better | 2 percentage points |

Reporting under exactly these two keys is enough for healing and optimizing to work. To have the
monitor act on another key — `refund`, `checkout.latency-breach` — define it for the project
with `POST /api/projects/{projectId}/metrics` (`key`, `name`, `direction`
`INCREASE_IS_BETTER`/`DECREASE_IS_BETTER`, `tau`, and `autoAct`). There is no dashboard screen for
metric definitions yet.

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

Now a prompt revision, a tool, or an entire sub-behaviour is a multivariate flag: split agent
traffic 50/50, report `error` and `conversion` events per run, and the rollout monitor compares
the variants for you — rolling back a prompt that starts failing and ramping one that measurably
does better. Because targeting reads attributes, you can scope an experiment to one agent
(`agent EQUALS meal-planner`) while everything else stays on the baseline.

The same run id always resolves to the same variation, so a run is reproducible: replay it
tomorrow or on another machine and it gets the prompt it got the first time.

The demo workspace's `agent-planner-prompt` flag (`make seed`) is a working example of exactly
this.
