# Switchboard Java SDK

An [OpenFeature](https://openfeature.dev) provider that evaluates flags **in process**.

```xml
<dependency>
  <groupId>com.switchboard</groupId>
  <artifactId>switchboard-java-sdk</artifactId>
  <version>0.1.0-SNAPSHOT</version>
</dependency>
```

```java
var provider = new SwitchboardProvider(
    SwitchboardConfig.builder(System.getenv("SWITCHBOARD_SDK_KEY")).build());
OpenFeature.getInstance().setProviderAndWait(provider);

var client = OpenFeature.getInstance().getClient();
boolean on = client.getBooleanValue("new-checkout", false,
    new MutableContext("user-3").add("plan", "pro"));
```

Or without OpenFeature, which is the same evaluation with one less dependency:

```java
try (var switchboard = new SwitchboardClient(SwitchboardConfig.builder(sdkKey).build())) {
    switchboard.start();
    boolean on = switchboard.booleanValue("new-checkout", false,
        EvalContexts.builder("user-3").put("plan", "pro").build()).value();
}
```

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

What this SDK does own is the mapping from the bootstrap wire format into that evaluator, so
that is where the tests point:

| suite | what it covers |
|---|---|
| `ConformanceThroughSdkTest` | all **474** evaluation vectors from `spec/conformance/`, replayed as bootstrap payloads through this SDK's own JSON parsing |
| `BootstrapCodecTest` | malformed payloads, forward compatibility, type preservation |
| `SseParserTest` | the event-stream framing rules |
| `SwitchboardClientTest` | the fail-safes, against a real HTTP server |
| `LiveCheckIT` | this SDK's answers vs **the server's answers** on a running stack |

`LiveCheckIT` is the one that matters most, and it has already earned its keep: it caught the
codec rejecting every real bootstrap payload because a live server serialises a single-variation
serve as `{"rollout": [], "variationId": "..."}` — the field present but empty — while every
hand-written test fixture omitted it entirely. Unit tests cannot find that class of bug.

```bash
make deps-up && make backend && make seed
SWITCHBOARD_SDK_KEY=sb_srv_production_... ./mvnw -pl sdk/java test -Dtest=LiveCheckIT
```

## Configuration

| option | default | |
|---|---|---|
| `baseUri` | `http://localhost:28080` | Switchboard API origin |
| `mode` | `STREAMING` | `STREAMING` (SSE) or `POLLING` (conditional GET) |
| `pollInterval` | 30s | polling mode only |
| `startTimeout` | 5s | how long `start()` waits for the first payload |
| `staleAfter` | 60s | marks the snapshot stale after this long with no traffic; 0 disables |
| `failFastOnStart` | `false` | see below |

**Use a SERVER key (`sb_srv_`).** A client-side key is refused the rule set with a 403 — loudly,
rather than being handed a reduced payload, because a silently smaller response is how an SDK
ends up serving defaults forever with nothing surfaced.

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
