package com.switchboard.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.fasterxml.jackson.databind.JsonNode;
import com.sun.net.httpserver.HttpServer;
import com.switchboard.sdk.internal.Transport;
import dev.openfeature.sdk.ImmutableContext;
import dev.openfeature.sdk.MutableContext;
import dev.openfeature.sdk.MutableTrackingEventDetails;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * Telemetry end to end against the JDK's HTTP server: the wire shape of
 * {@code POST /api/events/eval} and {@code POST /api/events/metrics}, 202 as success, which
 * evaluations record an exposure, and the OpenFeature routes into both.
 */
class TelemetryTest {

    private static final String ON = "0a0a0a0a-0000-4000-8000-000000000001";
    private static final String OFF = "0a0a0a0a-0000-4000-8000-000000000002";
    private static final String PAYLOAD = """
        {"envKey":"production","stateVersion":7,"segments":[],"flags":[
          {"key":"bool-on","kind":"BOOLEAN","enabled":true,"killSwitchActive":false,"version":1,
           "variations":[{"id":"%1$s","value":"true"},{"id":"%2$s","value":"false"}],
           "config":{"individualTargets":[],"rules":[],"fallthrough":{"variationId":"%1$s"},
             "offVariationId":"%2$s","defaultVariationId":"%1$s"}},
          {"key":"not-a-number","kind":"STRING","enabled":true,"killSwitchActive":false,"version":1,
           "variations":[{"id":"%2$s","value":"banana"}],
           "config":{"individualTargets":[],"rules":[],"fallthrough":{"variationId":"%2$s"},
             "offVariationId":"%2$s","defaultVariationId":"%2$s"}}]}
        """.formatted(ON, OFF);

    private HttpServer server;
    private String baseUri;
    private final Map<String, List<JsonNode>> bodies = new ConcurrentHashMap<>();
    private final List<String> authHeaders = new CopyOnWriteArrayList<>();
    private final AtomicInteger status = new AtomicInteger(202);

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        for (String path : List.of("/api/events/metrics", "/api/events/eval")) {
            server.createContext(path, exchange -> {
                byte[] raw = exchange.getRequestBody().readAllBytes();
                bodies.computeIfAbsent(path, p -> new CopyOnWriteArrayList<>())
                    .add(Transport.json().readTree(new String(raw, StandardCharsets.UTF_8)));
                authHeaders.add(exchange.getRequestHeaders().getFirst("Authorization"));
                exchange.sendResponseHeaders(status.get(), -1);
                exchange.close();
            });
        }
        server.createContext("/api/eval/bootstrap", exchange -> {
            byte[] body = PAYLOAD.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        server.createContext("/api/stream", exchange -> {
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
        });
        server.start();
        baseUri = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private SwitchboardConfig.Builder config() {
        return SwitchboardConfig.builder("sb_srv_test")
            .baseUri(baseUri)
            .startTimeout(Duration.ofSeconds(5))
            .flushInterval(Duration.ofHours(1));
    }

    private SwitchboardClient client() {
        return new SwitchboardClient(config().build());
    }

    private List<JsonNode> items(String path) {
        List<JsonNode> out = new ArrayList<>();
        bodies.getOrDefault(path, List.of()).forEach(body -> body.path("events").forEach(out::add));
        return out;
    }

    private List<JsonNode> metrics() {
        return items("/api/events/metrics");
    }

    private List<JsonNode> evals() {
        return items("/api/events/eval");
    }

    // ------------------------------------------------------------------ track()

    @Test
    void trackThenFlushPostsTheContractShape() {
        // Never started: tracking must not depend on a loaded flag payload.
        try (var client = client()) {
            client.track("conversion", "user-1");
            client.track("latency_ms", "user-2", 42.5);
            client.flush();

            assertEquals(1, bodies.get("/api/events/metrics").size());
            assertEquals("Bearer sb_srv_test", authHeaders.get(0));
            List<JsonNode> items = metrics();
            assertEquals(2, items.size());
            JsonNode first = items.get(0);
            assertEquals("user-1", first.path("contextKey").asText());
            assertEquals("conversion", first.path("metricKey").asText());
            assertEquals(1d, first.path("value").asDouble());
            // Parses as an instant, which is what format: date-time needs.
            Instant.parse(first.path("occurredAt").asText());
            assertEquals(42.5, items.get(1).path("value").asDouble());

            assertEquals(new TelemetryStats(0, 0, 0, 2, 0), client.telemetryStats());
        }
    }

    @Test
    void blankKeysAndNonFiniteValuesAreIgnoredNotThrown() {
        try (var client = client()) {
            client.track("", "user-1");
            client.track(null, "user-1");
            client.track("conversion", " ");
            client.track("conversion", null);
            client.track("latency", "user-1", Double.NaN);
            client.track("latency", "user-1", Double.POSITIVE_INFINITY);
            assertEquals(0, client.telemetryStats().queuedMetricEvents());
            client.flush();
            assertTrue(bodies.isEmpty());
        }
    }

    @Test
    void aNon202IsAFailedBatchNotAnException() {
        status.set(500);
        try (var client = client()) {
            client.track("error", "user-1");
            client.flush();
            TelemetryStats stats = client.telemetryStats();
            assertEquals(0, stats.sent());
            assertEquals(1, stats.failedFlushes());
        }
    }

    @Test
    void closeFlushesWhatIsBuffered() {
        var client = client();
        client.start();
        client.booleanValue("bool-on", false, EvalContexts.of("user-1"));
        client.track("conversion", "user-1");
        client.close();
        assertEquals(1, evals().size(), "a clean shutdown loses nothing");
        assertEquals(1, metrics().size(), "a clean shutdown loses nothing");
    }

    @Test
    void batchesAreCappedAtTheApiLimit() {
        assertEquals(500, SwitchboardConfig.MAX_BATCH_SIZE);
        try (var client = new SwitchboardClient(config().maxBatchSize(10_000).build())) {
            for (int i = 0; i < 1_200; i++) {
                client.track("conversion", "user-" + i);
            }
            client.flush();
        }
        assertTrue(bodies.get("/api/events/metrics").stream().allMatch(b -> b.path("events").size() <= 500));
        assertEquals(1_200, metrics().size());
    }

    @Test
    void telemetryDisabledSendsNeitherExposuresNorMetrics() {
        try (var client = new SwitchboardClient(config().telemetryEnabled(false).build())) {
            client.start();
            client.booleanValue("bool-on", false, EvalContexts.of("user-1"));
            client.track("conversion", "user-1");
            assertEquals(new TelemetryStats(0, 0, 0, 0, 0), client.telemetryStats());
            client.flush();
        }
        assertTrue(bodies.isEmpty());
    }

    // ------------------------------------------------------------------ exposures

    @Test
    void anEvaluationRecordsAnExposureWithTheContractShape() {
        try (var client = client()) {
            client.start();
            assertTrue(client.booleanValue("bool-on", false, EvalContexts.of("user-7")).value());
            client.flush();
        }
        List<JsonNode> items = evals();
        assertEquals(1, items.size());
        JsonNode item = items.get(0);
        assertEquals("bool-on", item.path("flagKey").asText());
        assertEquals("user-7", item.path("contextKey").asText());
        assertEquals(ON, item.path("variationId").asText());
        assertEquals("DEFAULT", item.path("reason").asText());
        Instant.parse(item.path("occurredAt").asText());
    }

    @Test
    void exposuresFollowTheTypeScriptRules() {
        try (var client = client()) {
            // Before a payload: no exposure (the flag was never reached).
            client.booleanValue("bool-on", false, EvalContexts.of("early"));
            client.start();
            // Bad context and unknown flag: no exposure.
            client.booleanValue("bool-on", false, null);
            client.booleanValue("no-such-flag", false, EvalContexts.of("u"));
            // Reached the flag but served the default on a parse failure: still an exposure,
            // because the variation WAS served as far as the flag's allocation is concerned.
            assertTrue(client.doubleValue("not-a-number", 1.5, EvalContexts.of("u")).isError());
            // allFlags is ordinary evaluation: one exposure per flag.
            client.allFlags(EvalContexts.of("all"));
            // One typed call is one exposure, even where one type is built on another.
            client.integerValue("bool-on", 0, EvalContexts.of("int"));
            client.flush();
        }
        // Sorted: allFlags iterates an unordered map.
        assertEquals(List.of("bool-on/all", "bool-on/int", "not-a-number/all", "not-a-number/u"),
            evals().stream().map(e -> e.path("flagKey").asText() + "/" + e.path("contextKey").asText())
                .sorted().toList());
    }

    // ------------------------------------------------------------------ OpenFeature

    @Test
    void providerTrackRoutesToTheClientWithTheTargetingKeyAndValue() {
        try (var client = client()) {
            var provider = new SwitchboardProvider(client);
            provider.track("conversion", new MutableContext("user-9"), null);
            provider.track("revenue", new MutableContext("user-9"), new MutableTrackingEventDetails(19.99));
            client.flush();

            List<JsonNode> items = metrics();
            assertEquals(2, items.size());
            assertEquals("user-9", items.get(0).path("contextKey").asText());
            assertEquals("conversion", items.get(0).path("metricKey").asText());
            assertEquals(1d, items.get(0).path("value").asDouble(), "the value defaults to 1");
            assertEquals("revenue", items.get(1).path("metricKey").asText());
            assertEquals(19.99, items.get(1).path("value").asDouble());
        }
    }

    @Test
    void theOpenFeatureApiRecordsExposuresAndTracks() {
        // Through the real OpenFeature runtime rather than calling the provider directly, so a
        // signature mismatch with FeatureProvider.track would show up as nothing being sent.
        var client = client();
        var api = dev.openfeature.sdk.OpenFeatureAPI.getInstance();
        String domain = "telemetry-test-" + System.nanoTime();
        try (client) {
            api.setProviderAndWait(domain, new SwitchboardProvider(client));
            var of = api.getClient(domain);
            assertTrue(of.getBooleanValue("bool-on", false, new MutableContext("user-of")));
            of.track("conversion", new MutableContext("user-of"), new MutableTrackingEventDetails(3));
            client.flush();
        } finally {
            api.shutdown();
        }
        List<JsonNode> exposures = evals();
        assertEquals(1, exposures.size());
        assertEquals("user-of", exposures.get(0).path("contextKey").asText());
        List<JsonNode> tracked = metrics();
        assertEquals(1, tracked.size());
        assertEquals("user-of", tracked.get(0).path("contextKey").asText());
        assertEquals(3d, tracked.get(0).path("value").asDouble());
    }

    @Test
    void providerTrackWithoutATargetingKeyIsIgnored() {
        try (var client = client()) {
            var provider = new SwitchboardProvider(client);
            provider.track("conversion", new ImmutableContext(), null);
            provider.track("conversion", null, new MutableTrackingEventDetails());
            assertEquals(0, client.telemetryStats().queuedMetricEvents());
        }
    }
}
