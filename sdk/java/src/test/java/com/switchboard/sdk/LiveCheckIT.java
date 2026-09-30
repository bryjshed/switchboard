package com.switchboard.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.switchboard.domain.evaluation.EvalContext;
import com.switchboard.domain.evaluation.EvalReason;
import com.switchboard.sdk.internal.Transport;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ThreadLocalRandom;
import org.junit.jupiter.api.Assumptions;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The Java SDK against a RUNNING stack, in the spirit of the other live checks: unit tests
 * cannot catch contract drift, and a local-evaluation SDK that has never parsed a real
 * bootstrap payload is not actually verified.
 *
 * <p>What it proves that nothing else does: that the SDK's in-process answer equals the
 * SERVER's answer for the same flag and context. Those go through completely different code
 * on each side - the SDK reads the bootstrap payload and evaluates locally, the server reads
 * its own snapshot cache and evaluates remotely - so agreement is a real signal.
 *
 * <p>Self-skips unless {@code SWITCHBOARD_SDK_KEY} is set, because it needs a seeded stack:
 *
 * <pre>
 *   make deps-up &amp;&amp; make backend &amp;&amp; make seed
 *   SWITCHBOARD_SDK_KEY=sb_srv_production_... \
 *     ./mvnw -pl sdk/java -am test -Dtest=LiveCheckIT
 * </pre>
 *
 * <p>The metric read-back also signs in as a dashboard user with a local dev token
 * ({@code SWITCHBOARD_DEV_USER}, default the seeded owner {@code alice@switchboard.dev}), and
 * skips itself if the server does not accept dev tokens.
 */
class LiveCheckIT {

    private static final String BASE = System.getenv().getOrDefault("SWITCHBOARD_BASE_URL", "http://localhost:28080");
    private static String sdkKey;

    @BeforeAll
    static void requireAStack() {
        sdkKey = System.getenv("SWITCHBOARD_SDK_KEY");
        Assumptions.assumeTrue(sdkKey != null && !sdkKey.isBlank(),
            "set SWITCHBOARD_SDK_KEY to run the live check against a seeded stack");
    }

    private SwitchboardClient client() {
        return new SwitchboardClient(SwitchboardConfig.builder(sdkKey)
            .baseUri(BASE)
            .startTimeout(Duration.ofSeconds(10))
            .build());
    }

    @Test
    void loadsARealBootstrapAndEvaluatesLocally() {
        try (var client = client()) {
            client.start();
            assertTrue(client.isReady(), "the SDK should have loaded a payload from " + BASE);
            assertTrue(client.stateVersion() > 0, "a real environment has a stateVersion");
            assertFalse(client.allFlags(EvalContexts.of("live-user-1")).isEmpty(),
                "the seeded environment should carry flags");
        }
    }

    /**
     * The one that matters: local evaluation must agree with the server, flag for flag and
     * context for context. A mapping bug in {@code BootstrapCodec} shows up here as a
     * disagreement and nowhere else.
     */
    @Test
    void agreesWithTheServerOnEveryFlag() throws Exception {
        try (var client = client()) {
            client.start();
            Assumptions.assumeTrue(client.isReady(), "no payload; is the backend seeded?");

            HttpClient http = HttpClient.newHttpClient();
            int compared = 0;
            for (String flagKey : client.allFlags(EvalContexts.of("x")).keySet()) {
                for (String contextKey : new String[] {"live-user-1", "live-user-2", "live-user-77"}) {
                    EvalContext context = EvalContexts.builder(contextKey).put("plan", "pro").build();
                    String local = client.evaluate(flagKey, null, context).value();

                    String body = """
                        {"context":{"key":"%s","attributes":{"plan":"pro"}}}""".formatted(contextKey);
                    HttpResponse<String> response = http.send(
                        HttpRequest.newBuilder(URI.create(BASE + "/api/eval/" + flagKey))
                            .header("Authorization", "Bearer " + sdkKey)
                            .header("Content-Type", "application/json")
                            .POST(HttpRequest.BodyPublishers.ofString(body))
                            .build(),
                        HttpResponse.BodyHandlers.ofString());
                    assertEquals(200, response.statusCode(), "server eval of " + flagKey);

                    String remote = com.switchboard.sdk.internal.Transport.json()
                        .readTree(response.body()).path("value").asText();
                    assertEquals(remote, local,
                        "local and server evaluation disagree for flag=" + flagKey + " context=" + contextKey);
                    compared++;
                }
            }
            assertTrue(compared > 0, "nothing was compared");
            System.out.println("live-check: " + compared + " local/server evaluations agreed");
        }
    }

    @Test
    void aClientKeyIsRefusedTheRuleSetLoudly() {
        // A silently smaller payload is how an SDK ends up serving defaults forever with
        // nothing surfaced, so the server 403s a client key here rather than reducing it.
        Assumptions.assumeTrue(sdkKey.startsWith("sb_srv_"), "needs a server key to contrast against");
        try (var client = new SwitchboardClient(SwitchboardConfig.builder("sb_cli_definitely-not-real")
            .baseUri(BASE).startTimeout(Duration.ofSeconds(3)).build())) {
            client.start();
            assertFalse(client.isReady(), "an invalid/client key must not produce a loaded client");
            assertNotNull(client.booleanValue("anything", true, EvalContexts.of("u")).errorKind());
        }
    }

    // ------------------------------------------------------------------ track()

    /**
     * {@code track()} through a real flush: the server must answer 202 for every batch. A
     * contract drift in the MetricEventItem shape shows up here as a failed flush.
     */
    @Test
    void trackedMetricsAreAcceptedByTheServer() {
        try (var client = client()) {
            String run = UUID.randomUUID().toString();
            client.track("conversion", "live-track-" + run + "-1");
            client.track("latency_ms", "live-track-" + run + "-2", 87.5);
            client.track("error", "live-track-" + run + "-3");
            client.flush();
            TelemetryStats stats = client.telemetryStats();
            assertEquals(0, stats.failedFlushes(), "a batch was refused; see the log for the status");
            assertEquals(0, stats.dropped());
            assertEquals(3, stats.sent());
            assertEquals(0, stats.queuedMetricEvents());
        }
    }

    /**
     * The read-back, and the reason exposures exist: a conversion tracked by this SDK must show
     * up in the server's rollout stats, attributed to the variation the SDK served.
     *
     * <p>Rollout stats attribute a metric to a variation ONLY by joining it to an evaluation
     * event for the same context key. Nothing is posted by hand here: the exposures come from
     * the SDK's own local evaluations, and the conversions from {@code track()}, so this fails
     * if either half of the SDK's telemetry is missing or malformed.
     *
     * <p>It compares conversion counts before and after, over a random window of a few hundred
     * hours: the server caches stats for a minute per window, and "after" uses a strictly wider
     * window than "before", so the delta can only be understated by concurrent traffic, never
     * overstated. Only a flag that serves these contexts WITHOUT a rollout is used, so the
     * injected conversions cannot move the rollout monitor to ramp or roll back a seeded flag.
     */
    @Test
    void aTrackedConversionShowsUpInTheServersRolloutStats() throws Exception {
        HttpClient http = HttpClient.newHttpClient();
        String userToken = "Bearer dev:"
            + System.getenv().getOrDefault("SWITCHBOARD_DEV_USER", "alice@switchboard.dev");
        String envId = environmentOfTheSdkKey(http, userToken);
        Assumptions.assumeTrue(envId != null,
            "could not resolve the SDK key's environment with a dev token; skipping the read-back");

        try (var client = client()) {
            client.start();
            Assumptions.assumeTrue(client.isReady(), "no payload; is the backend seeded?");

            String run = UUID.randomUUID().toString();
            String[] contexts = new String[5];
            for (int i = 0; i < contexts.length; i++) {
                contexts[i] = "live-track-" + run + "-" + i;
            }
            // Choosing a flag evaluates candidates this test will not use; do that on a
            // second, telemetry-off client so it reports no exposures for them.
            String flagKey = null;
            Map<String, EvaluationDetail<String>> served = new LinkedHashMap<>();
            try (var chooser = new SwitchboardClient(SwitchboardConfig.builder(sdkKey)
                .baseUri(BASE).startTimeout(Duration.ofSeconds(10)).telemetryEnabled(false).build())) {
                chooser.start();
                for (String candidate : chooser.allFlags(EvalContexts.of("x")).keySet()) {
                    served.clear();
                    for (String contextKey : contexts) {
                        EvaluationDetail<String> detail =
                            chooser.evaluate(candidate, null, EvalContexts.of(contextKey));
                        if (detail.isError() || detail.variationId() == null
                            || detail.reason() == EvalReason.ROLLOUT) {
                            break;
                        }
                        served.put(contextKey, detail);
                    }
                    if (served.size() == contexts.length) {
                        flagKey = candidate;
                        break;
                    }
                }
            }
            Assumptions.assumeTrue(flagKey != null, "no flag serves a fresh context outside a rollout");

            int hoursBefore = ThreadLocalRandom.current().nextInt(100, 600);
            Map<String, long[]> before = rolloutCounts(http, userToken, envId, flagKey, hoursBefore);

            // The exposures: the SDK's own local evaluation, recording as it goes.
            for (String contextKey : contexts) {
                EvaluationDetail<String> detail = client.evaluate(flagKey, null, EvalContexts.of(contextKey));
                assertEquals(served.get(contextKey).variationId(), detail.variationId());
            }
            // The part under test.
            for (String contextKey : contexts) {
                client.track("conversion", contextKey);
            }
            client.flush();
            TelemetryStats stats = client.telemetryStats();
            assertEquals(0, stats.failedFlushes(), "a telemetry batch was refused; see the log");
            assertTrue(stats.sent() >= 2L * contexts.length,
                "the SDK should have delivered every exposure and metric, sent=" + stats.sent());

            Map<String, long[]> after = rolloutCounts(http, userToken, envId, flagKey, hoursBefore + 1);
            Map<String, Integer> expected = new HashMap<>();
            served.values().forEach(d -> expected.merge(d.variationId().toString(), 1, Integer::sum));
            for (var entry : expected.entrySet()) {
                long[] was = before.getOrDefault(entry.getKey(), new long[2]);
                long[] current = after.getOrDefault(entry.getKey(), new long[2]);
                Assumptions.assumeTrue(was[1] < was[0] || was[0] == 0,
                    "conversion rate already capped at 1 for " + entry.getKey() + "; a delta is unobservable");
                assertTrue(current[0] - was[0] >= entry.getValue(),
                    "eval count for " + entry.getKey() + " rose by " + (current[0] - was[0]));
                assertTrue(current[1] - was[1] >= entry.getValue(),
                    "conversions for " + flagKey + "/" + entry.getKey() + " rose by " + (current[1] - was[1])
                        + ", expected at least " + entry.getValue() + ": the tracked metrics did not arrive");
            }
            System.out.println("live-check: " + contexts.length
                + " tracked conversions read back from rollout stats of " + flagKey);
        }
    }

    /** variationId to {evalCount, conversions}; conversions recovered from the rate. */
    private static Map<String, long[]> rolloutCounts(
        HttpClient http, String userToken, String envId, String flagKey, int hours) throws Exception {
        JsonNode stats = getJson(http, userToken,
            "/api/environments/" + envId + "/flags/" + flagKey + "/rollout-stats?hours=" + hours);
        assertNotNull(stats, "rollout-stats for " + flagKey);
        Map<String, long[]> counts = new HashMap<>();
        for (JsonNode total : stats.path("totals")) {
            long evals = total.path("evalCount").asLong();
            long conversions = Math.round(total.path("conversionRate").asDouble() * evals);
            counts.put(total.path("variationId").asText(), new long[] {evals, conversions});
        }
        return counts;
    }

    /** Walks orgs, projects and environments for the SDK key whose prefix matches ours. */
    private static String environmentOfTheSdkKey(HttpClient http, String userToken) throws Exception {
        JsonNode orgs = getJson(http, userToken, "/api/orgs");
        if (orgs == null) {
            return null;
        }
        for (JsonNode org : orgs) {
            JsonNode projects = getJson(http, userToken, "/api/orgs/" + org.path("id").asText() + "/projects");
            for (JsonNode project : projects == null ? Transport.json().createArrayNode() : projects) {
                JsonNode envs = getJson(http, userToken,
                    "/api/projects/" + project.path("id").asText() + "/environments");
                for (JsonNode env : envs == null ? Transport.json().createArrayNode() : envs) {
                    JsonNode keys = getJson(http, userToken,
                        "/api/environments/" + env.path("id").asText() + "/sdk-keys");
                    for (JsonNode key : keys == null ? Transport.json().createArrayNode() : keys) {
                        // The server lists a truncated prefix ending in an ellipsis ("sb_srv_produ…").
                        String prefix = key.path("keyPrefix").asText("").replaceAll("[….]+$", "");
                        if (!key.hasNonNull("revokedAt") && !prefix.isEmpty() && sdkKey.startsWith(prefix)) {
                            return env.path("id").asText();
                        }
                    }
                }
            }
        }
        return null;
    }

    /** GET as a dashboard user; null on any non-200, so callers can skip rather than fail. */
    private static JsonNode getJson(HttpClient http, String userToken, String path) throws Exception {
        HttpResponse<String> response = http.send(
            HttpRequest.newBuilder(URI.create(BASE + path)).header("Authorization", userToken).GET().build(),
            HttpResponse.BodyHandlers.ofString());
        return response.statusCode() == 200 ? Transport.json().readTree(response.body()) : null;
    }
}
