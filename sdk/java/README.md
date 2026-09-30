# Switchboard Java SDK

An [OpenFeature](https://openfeature.dev) provider that evaluates flags **in process**, and
reports evaluations and outcomes back so Switchboard's healing and optimizing loop can judge a
rollout.

## Install

The SDK is not published to Maven Central yet. Build it from this repository — it needs **JDK 25**
to build, and your application must run on **Java 25 or newer** (the jars target release 25):

```bash
# from the repository root
JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw -pl evaluation,sdk/java -am install -DskipTests
```

That installs two artifacts into your local Maven repository: `switchboard-java-sdk` and the
evaluator it depends on, `switchboard-evaluation`. (`JAVA_HOME=...` is the macOS form; anywhere
else, point `JAVA_HOME` at a JDK 25.) To share them with a team, deploy both to your internal
repository — see [self-hosting.md](../../docs/self-hosting.md#9-build-the-sdks-for-your-developers).

```xml
<dependency>
  <groupId>com.switchboard</groupId>
  <artifactId>switchboard-java-sdk</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

Gradle: `implementation("com.switchboard:switchboard-java-sdk:0.1.0-SNAPSHOT")`, with
`mavenLocal()` or your internal repository in `repositories`.

## Quickstart

Get a **server** key (`sb_srv_…`) from **Settings → SDK keys** in the dashboard.

```java
var provider = new SwitchboardProvider(
    SwitchboardConfig.builder(System.getenv("SWITCHBOARD_SDK_KEY"))
        .baseUri("https://switchboard.example.com")
        .build());
OpenFeature.getInstance().setProviderAndWait(provider);

var client = OpenFeature.getInstance().getClient();
boolean on = client.getBooleanValue("new-checkout", false,
    new MutableContext("user-3").add("plan", "pro"));

client.track("conversion", new MutableContext("user-3"));   // an outcome, for the AI layer

// on shutdown: stops the stream and flushes buffered events
OpenFeature.getInstance().shutdown();
```

Or without OpenFeature, which is the same evaluation with one less dependency:

```java
try (var switchboard = new SwitchboardClient(SwitchboardConfig.builder(sdkKey)
        .baseUri("https://switchboard.example.com").build())) {
    switchboard.start();
    boolean on = switchboard.booleanValue("new-checkout", false,
        EvalContexts.builder("user-3").put("plan", "pro").build()).value();
    switchboard.track("conversion", "user-3");
}
```

`booleanValue`, `stringValue`, `integerValue`, `doubleValue` and `jsonValue` each return an
`EvaluationDetail` carrying the value, variation, reason and matched rule. `allFlags(context)`
evaluates everything. For a Spring Boot bean, see
[integrating.md](../../docs/integrating.md#java).

## Why this exists when OFREP already covers Java

OFREP gives Java an OpenFeature provider with no Switchboard-specific code, and for many
applications that is the right choice. It is *remote* evaluation: a network round trip per
flag check.

This SDK holds the environment's rule set in memory and evaluates locally. That buys three
things OFREP cannot:

- **No I/O on the hot path.** A flag check is a map lookup and an MD5.
- **It keeps working when Switchboard does not.** An outage stops updates, not evaluation.
- **Context attributes never leave the process.**

If none of those matter to you, use the OFREP provider.

## It cannot disagree with the server

Bucketing, the sixteen operators, semver ordering, the restricted regex subset and the
precedence ladder are **not implemented here**. They come from `switchboard-evaluation`, the
same module the Switchboard server itself runs. There is one implementation, so there is
nothing for a second one to drift from.

## Configuration

Everything but the SDK key is set on `SwitchboardConfig.builder(sdkKey)`.

| option | default | |
|---|---|---|
| `baseUri` | `http://localhost:28080` | Switchboard API origin. **Set it** — the default is the development stack. |
| `mode` | `STREAMING` | `STREAMING` (SSE) or `POLLING` (conditional GET) |
| `pollInterval` | 30s | polling mode only |
| `startTimeout` | 5s | how long `start()` waits for the first payload |
| `requestTimeout` | 10s | per-request timeout on every HTTP call, including event flushes |
| `staleAfter` | 60s | marks the snapshot stale after this long with no traffic; 0 disables |
| `failFastOnStart` | `false` | see below |
| `flushInterval` | 10s | how often buffered events are sent; `Duration.ZERO` sends only on `flush()` and `close()` |
| `maxBatchSize` | 500 | events per request, clamped to 1..500 (the API's limit) |
| `maxQueueSize` | 10000 | events held in memory, per queue (evaluations and metrics); past this the **oldest** are dropped |
| `telemetryEnabled` | `true` | one switch for both evaluation events and `track()`; off, `track()` does nothing and the AI layer sees nothing from this application |

**Use a SERVER key (`sb_srv_`).** A client-side key is refused the rule set with a 403 — loudly,
rather than being handed a reduced payload, because a silently smaller response is how an SDK
ends up serving defaults forever with nothing surfaced.

## Reporting outcomes

Switchboard's AI layer rolls a rollout back when a variation starts erroring and ramps one that
converts better. It judges that from two kinds of event, and this SDK sends both, so healing and
optimizing work with local evaluation:

- **Evaluations** — which variation each context was served. Recorded for you: one event per
  evaluation of a known flag for a valid context once the client has loaded, including
  evaluations that served your default because the flag's value was unusable. Nothing is recorded
  for an unknown flag, a client that is not ready yet, or a blank context key. There is no
  sampling or de-duplication; rates are computed per distinct subject, so volume does not skew
  them.
- **Outcomes** — yours to report:

```java
switchboard.track("conversion", "user-42");               // value 1
switchboard.track("error", "user-42");
switchboard.track("checkout.latency-ms", "user-42", 318); // a measurement
```

Use the **same context key you evaluated with**; that is how an outcome is attributed to the
variation that context was served. `error` and `conversion` are defined in every project; other
keys are stored but drive healing and optimizing only once the project defines them — see
[integrating.md](../../docs/integrating.md#which-metrics-drive-healing-and-optimizing).
Through OpenFeature, `client.track(name, context[, details])` does the same; the context's
targeting key is required, and the value defaults to 1.

`track` never blocks and never throws. Both kinds of event are queued and sent by a background
worker every `flushInterval`; metrics are also sent as soon as `maxBatchSize` of them are waiting.
A blank metric key, or a NaN or infinite value, is logged and ignored. A failed batch is logged
and dropped rather than retried, and each queue is bounded, so an outage cannot grow memory
without bound.

- `flush()` sends everything queued — evaluations, then metrics — and blocks until done (each
  request bounded by `requestTimeout`). Use it before a short-lived process exits.
- `close()` stops the stream, then flushes once more. Always close the client on shutdown —
  `try`-with-resources, `@Bean(destroyMethod = "close")`, or `OpenFeature.getInstance().shutdown()`
  for a provider built from a config.
- `telemetryStats()` reports `queuedEvalEvents`, `queuedMetricEvents`, `sent`, `dropped` (events
  lost to a full queue) and `failedFlushes` (batches the server did not accept), for your own
  dashboards.

Metrics need a **server** key; a client-side key is refused them.

## It serves defaults rather than throwing

Every evaluation returns a value. An unknown flag, an unparseable variation, a context with no
targeting key, a client that has not loaded yet — all serve the caller's default and report why
in `errorKind`. A flag system that can take an application down when it does not recognise a key
is worse than no flag system.

That is why **`failFastOnStart` defaults to false**. If Switchboard is briefly unreachable at
start-up, the client starts anyway, serves defaults, keeps retrying in the background, and
reports `isReady() == false` so a health check can see the truth. Refusing to start would convert
a degraded dependency into an outage of the application that depends on it. Turn it on only if
serving defaults is genuinely worse than not starting.

Two signals worth surfacing in your own health endpoint:

```java
switchboard.isReady();   // false until a payload has landed
switchboard.isStale();   // true when nothing has arrived for staleAfter
```

`isStale()` exists because silently serving stale flags is the failure mode nobody notices.

## Reason mapping

OpenFeature's reasons are coarser than Switchboard's, so the mapping is lossy in one direction
and the detail is preserved alongside it:

| Switchboard | OpenFeature | |
|---|---|---|
| `KILL_SWITCH`, `FLAG_OFF` | `DISABLED` | |
| `TARGET_MATCH`, `RULE_MATCH` | `TARGETING_MATCH` | |
| `ROLLOUT` | `SPLIT` | |
| `DEFAULT`, `SDK_DEFAULT` | `DEFAULT` | |

The exact reason, the variation id and the matched rule id are all in `flagMetadata`
(`switchboardReason`, `variationId`, `ruleId`), so the distinctions the dashboard and audit
trail depend on survive the trip.

## Dependencies

`switchboard-evaluation` (JDK-only), `dev.openfeature:sdk` (which brings only `slf4j-api`), and
`jackson-databind`. There is no HTTP client dependency — `java.net.http` serves both the
conditional bootstrap and the SSE stream.

## Developing the SDK

From the repository root, with `JAVA_HOME` pointing at JDK 25:

```bash
./mvnw -pl sdk/java -am test          # -am builds switchboard-evaluation from the reactor first
```

The evaluator is shared with the server; what this SDK owns is the mapping from the bootstrap
wire format into it, plus transport and telemetry, so that is where the tests point:

| suite | what it covers |
|---|---|
| `ConformanceThroughSdkTest` | all **474** evaluation vectors from `spec/conformance/`, replayed as bootstrap payloads through this SDK's own JSON parsing |
| `BootstrapCodecTest` | malformed payloads, forward compatibility, type preservation |
| `SseParserTest` | the event-stream framing rules |
| `SwitchboardClientTest` | the fail-safes, against a real HTTP server |
| `TelemetryBufferTest` | the bounded queues: batching, drop-oldest at the cap, stats |
| `TelemetryTest` | exposures and `track()` against a real HTTP server: the wire shape, the final flush on close, provider `track` routing |
| `SwitchboardProviderTest` | the OpenFeature provider: context mapping, readiness, metadata |
| `LiveCheckIT` | this SDK's answers vs **the server's answers** on a running stack |

`LiveCheckIT` is the one that matters most, and it has already earned its keep: it caught the
codec rejecting every real bootstrap payload because a live server serialises a single-variation
serve as `{"rollout": [], "variationId": "..."}` — the field present but empty — while every
hand-written test fixture omitted it entirely. Unit tests cannot find that class of bug.

```bash
make deps-up && make backend && make seed
SWITCHBOARD_SDK_KEY=sb_srv_production_... \
  JAVA_HOME=$(/usr/libexec/java_home -v 25) ./mvnw -pl sdk/java -am test -Dtest=LiveCheckIT \
  -Dsurefire.failIfNoSpecifiedTests=false
```

