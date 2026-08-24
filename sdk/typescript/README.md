# @switchboard/openfeature-provider

Switchboard feature flags for Node.js. Flags are evaluated **in your process**, against config the
SDK holds in memory and keeps current over a streaming connection. A flag check is a map lookup and
an MD5, so it costs microseconds and it works whether or not the Switchboard backend is reachable.

Ships two entry points from one package:

- `@switchboard/openfeature-provider` - an [OpenFeature](https://openfeature.dev) provider.
- `@switchboard/openfeature-provider/core` - the plain `SwitchboardClient`, with zero runtime
  dependencies, for anyone who does not want OpenFeature in their tree.

Both evaluate identically. The provider is a thin wrapper over the client.

## Install

```bash
npm install @switchboard/openfeature-provider
# only if you want the OpenFeature API:
npm install @openfeature/server-sdk
```

Node 18.17 or newer (the SDK uses the global `fetch`). ESM and CommonJS builds are both published.

## Quickstart with OpenFeature

```ts
import { OpenFeature } from '@openfeature/server-sdk';
import { SwitchboardProvider } from '@switchboard/openfeature-provider';

await OpenFeature.setProviderAndWait(
  new SwitchboardProvider({ sdkKey: process.env.SWITCHBOARD_SDK_KEY! }),
);

const client = OpenFeature.getClient();
const newCheckout = await client.getBooleanValue('new-checkout', false, { targetingKey: 'user-42' });
const prompt = await client.getStringValue('agent-planner-prompt', 'prompt-v1', {
  targetingKey: 'user-42',
  agent: 'meal-planner',
});
```

`targetingKey` is the bucketing input. Every other context field is an attribute your rules can
test. `setProviderAndWait` resolves even when the backend is down; see
[When the backend is unreachable](#when-the-backend-is-unreachable).

## Quickstart without OpenFeature

```ts
import { SwitchboardClient } from '@switchboard/openfeature-provider/core';

const switchboard = new SwitchboardClient({ sdkKey: process.env.SWITCHBOARD_SDK_KEY! });
await switchboard.start();

const context = { key: 'user-42', attributes: { plan: 'pro', platform: 'ios' } };
const newCheckout = switchboard.booleanValue('new-checkout', context, false);
const prompt = switchboard.stringValue('agent-planner-prompt', context, 'prompt-v1');

switchboard.track('checkout.completed', 'user-42');
await switchboard.close(); // on shutdown: stops the stream and flushes telemetry
```

Evaluation is synchronous because there is no I/O on the path. `booleanValue`, `stringValue`,
`numberValue` and `jsonValue` each have a `...Detail` twin (`booleanDetail`, and so on) that returns
the value plus the variation, the reason, the rule that matched, the state version it came from and
whether the config is stale. `allFlags(context)` evaluates everything the client knows about.

## Configuration

Everything but `sdkKey` is optional.

| Option | Type | Default | What it does |
| --- | --- | --- | --- |
| `sdkKey` | `string` | required | Server-side key, `sb_srv_...`. Scopes the client to one environment. |
| `baseUrl` | `string` | `http://localhost:28080` | Switchboard API origin. |
| `mode` | `'streaming' \| 'polling'` | `'streaming'` | `streaming` holds an SSE connection; `polling` re-fetches bootstrap on an interval with `If-None-Match`. |
| `pollIntervalMs` | `number` | `30000` | Poll interval in `polling` mode. |
| `bootstrapTimeoutMs` | `number` | `5000` | Timeout on the initial bootstrap and on every other HTTP call. |
| `staleAfterMs` | `number` | `60000` | Marks the config stale after this long with no contact, and emits `stale`. `0` disables. |
| `telemetry` | `boolean \| TelemetryOptions` | on | See [Metrics](#metrics-that-feed-the-healing-loop). `false` disables it entirely. |
| `telemetry.flushIntervalMs` | `number` | `10000` | Background flush interval. `0` means flush only on `flush()` and `close()`. |
| `telemetry.maxQueueSize` | `number` | `10000` | Per-queue cap. Past this the **oldest** events are dropped. |
| `telemetry.maxBatchSize` | `number` | `500` | Events per HTTP request. The API caps a batch at 500. |
| `logger` | `Logger` | warn/error to console | Any object with `error`/`warn`/`info`/`debug`. A logger that throws cannot break the SDK. |
| `fetch` | `typeof fetch` | global | Injectable, for proxy agents and tests. |
| `initialBootstrap` | `BootstrapResponse` | none | Seed the store from a snapshot so the very first evaluation is never a default. |

`new SwitchboardClient({...})` throws only on a configuration that could never work (a missing
`sdkKey`, a negative interval, no `fetch` available). That constructor is the **only** place this
SDK throws. Nothing on the evaluation path ever does.

## How it works

```
start()
  |
  +-- GET /api/eval/bootstrap        every flag, variation and segment for this environment
  |     ETag: "<stateVersion>"       -> in-memory snapshot
  |
  +-- GET /api/stream (SSE)          held open
        put    -> replace the whole snapshot
        patch  -> upsert one flag's config, leave the rest untouched
        ping   -> liveness, every 15s

booleanValue(...) -> map lookup + precedence ladder + MD5 bucket. No network, no await.
```

The SSE event id is the environment's `stateVersion`, so a reconnect sends `Last-Event-ID` and the
server catches the client up from exactly where it left off. A `patch` for a flag the client has
never seen cannot be applied (a patch carries no variations), so the client resynchronises from
bootstrap rather than guessing.

Reconnects use exponential backoff with **full jitter**: `random(0, min(30s, 1s * 2^attempt))`.
Jitter matters because a backend restart otherwise brings every SDK instance back in the same
millisecond and knocks the recovering service over again. A successful connection resets the curve.
The one failure the client does not retry is `401`/`403`: the key is wrong, and retrying cannot fix
that.

Prefer `polling` mode where long-lived connections are awkward (some serverless platforms, some
proxies). It sends `If-None-Match`, so an unchanged environment costs a `304` and no body.

### When the backend is unreachable

The SDK is on the critical path of everything that reads a flag, so it never propagates a transport
failure to you. In order of preference it serves:

1. **The last config it had.** A dropped stream changes nothing about evaluation. Answers keep
   coming from the snapshot in memory, `detail.stale` turns `true` after `staleAfterMs`, a `stale`
   event fires, and the client reconnects in the background.
2. **A snapshot you seeded.** Persist `client.snapshot` (or a bootstrap body) somewhere and pass it
   as `initialBootstrap`, and a backend that is down at process start is survivable too.
3. **Your own default**, with `reason: 'SDK_DEFAULT'` and an `errorKind` saying why.

Concretely:

| What happened | What you get |
| --- | --- |
| Initial bootstrap fails | `start()` resolves anyway. `status` is `ERROR`, evaluations return your default with `errorKind: 'CLIENT_NOT_READY'`, and the transport keeps retrying. When the backend returns, the client catches up on its own. |
| Stream drops mid-run | Last-known config keeps serving. Reconnect with jittered backoff and `Last-Event-ID`. |
| SDK key rejected (401/403) | An `error` event with `willRetry: false`, logged at error level. The client stops reconnecting and keeps serving whatever it already had. |
| Flag key not in the environment | Your default, `reason: 'SDK_DEFAULT'`, `errorKind: 'FLAG_NOT_FOUND'`. Not an error. |
| Blank or whitespace context key | Your default, `errorKind: 'INVALID_CONTEXT'`. The SDK will not invent a bucketing key. |
| Config points at a deleted variation, or a rollout whose weights do not sum to 100 | Your default, `errorKind: 'CONFIG_UNREADABLE'`. Weights are never silently rescaled. |
| Value will not parse as the type you asked for | Your default, `errorKind: 'PARSE_ERROR'`. `numberValue` never returns `NaN`. |
| Telemetry flush fails | Logged and counted in `telemetryStats`. The batch is dropped, never retried forever. |
| One of your `on('change')` listeners throws | Caught and logged. It cannot break the SDK or other listeners. |

Watch it happen with `client.on('error' | 'stale' | 'ready' | 'change', ...)` and `client.status`
(`NOT_READY`, `READY`, `STALE`, `ERROR`).

## Reason codes

Every detail carries Switchboard's own `reason`, from
[`spec/evaluation.md`](../../spec/evaluation.md). They are the precedence ladder, in order:

| Reason | Meaning |
| --- | --- |
| `KILL_SWITCH` | The flag's kill switch is on in this environment. Off variation, no other rule is consulted. |
| `FLAG_OFF` | The flag is disabled in this environment. Off variation. |
| `TARGET_MATCH` | This exact context key is in the flag's individual target list. |
| `RULE_MATCH` | The first matching targeting rule decided it. `ruleId` says which one. The rule's serve may itself be a rollout. |
| `ROLLOUT` | A percentage rollout bucketed this context. Deterministic: same flag key and context key always land in the same bucket. |
| `DEFAULT` | Nothing targeted this context, so the fallthrough variation was served. This is a normal, successful evaluation. |
| `SDK_DEFAULT` | The SDK could not use the flag's own value and served **your** default. Read `errorKind` for why. |

`SDK_DEFAULT` is the only reason that means something went wrong, and even then only in the sense
that the caller's fallback was used. Unknown flags are the common, expected case.

Through OpenFeature these map onto the standard reasons (`DISABLED`, `TARGETING_MATCH`, `SPLIT`,
`DEFAULT`). The mapping is lossy in that direction, so the exact Switchboard reason is preserved in
`flagMetadata.switchboardReason`, alongside `variationId`, `ruleId`, `stateVersion` and `stale`.
`resolution.variant` carries the variation's display name where the flag defines one. A detail whose
`errorKind` is set surfaces as OpenFeature `reason: 'ERROR'` with the matching `errorCode`, and a
locally computed answer from config older than `staleAfterMs` surfaces as `reason: 'STALE'`.

## Metrics that feed the healing loop

Switchboard's AI layer watches metrics per variation: it rolls a rollout back when the new variant
starts erroring, and drafts the next ramp step when it converts better. That loop is fed by these
events, so telemetry is on by default.

Evaluation events are recorded for you on every local evaluation. Outcomes are yours to send:

```ts
switchboard.track('checkout.completed', 'user-42');      // a conversion
switchboard.track('checkout.error', 'user-42');          // a failure
switchboard.track('checkout.latency-ms', 'user-42', 318); // a measurement
```

Use the **same context key you evaluated with**. That is how an outcome gets attributed back to the
variation that context was served.

Through OpenFeature, `client.track('checkout.completed', ctx, { value: 1 })` routes to the same
place.

Both queues are batched and flushed every `flushIntervalMs`, on `flush()`, and on `close()`. Each is
bounded at `maxQueueSize`; past the cap the **oldest** events are dropped, so an outage cannot turn
into an out-of-memory kill, and the most recent behaviour (the part anomaly detection needs) is what
survives. `client.telemetryStats` reports queue depths, `sent`, `dropped` and `failedFlushes`.

Call `close()` on shutdown. It stops the stream, clears timers and flushes what is buffered.

## Gating an agent run

Flag context is not only users. Bucketing is a pure function of `flagKey + ":" + contextKey`, so any
stable identifier works, including a run id:

```ts
const runId = 'run-8f21c4';
const context = { key: runId, attributes: { agent: 'meal-planner' } };

const prompt = switchboard.stringValue('agent-planner-prompt', context, 'prompt-v1');
const result = await planMeals({ promptVersion: prompt });

switchboard.track('planner.accepted', runId);
switchboard.track('planner.tokens', runId, result.usage.totalTokens);
```

With a rule on `agent == 'meal-planner'` serving a 50/50 split, half of that agent's runs get
`prompt-v2` and the rest stay on the baseline, while every other agent keeps the fallthrough. The
metrics you `track()` against the same `runId` tell Switchboard which prompt is winning, and its
optimizing loop drafts the ramp.

**The same run id always resolves to the same variation.** That is what makes a run reproducible:
replay `run-8f21c4` tomorrow, or on another machine, or against the server's own
`POST /api/eval/{flagKey}`, and it still gets the prompt it got the first time. Widening a rollout
from 10% to 25% does not reshuffle anyone; it only adds runs.

## Correctness

Evaluation behaviour is defined by [`spec/evaluation.md`](../../spec/evaluation.md), not by this
implementation. This SDK is verified against the shared conformance vectors in
[`spec/conformance/`](../../spec/conformance) (201 vectors covering precedence, clause operators,
segments, bucketing, stickiness across ramps and rollout weight rules), the same files the Java
reference implementation runs. If this SDK and the server ever disagree, one of them is failing a
vector.

```bash
npm test           # conformance vectors + transport + telemetry
npm run conformance
npm run check      # typecheck, lint, test, build
node scripts/live-check.mjs   # against a running backend: local evaluation vs POST /api/eval
```

`scripts/live-check.mjs` is the end-to-end proof. It mints a real SDK key, boots a client, and for
every seeded flag across ten contexts asserts that the answer computed locally matches the answer
the server returns for the same context (value, variation, reason and rule), then flips a flag
through the management API and times how long the SSE stream takes to deliver it.
