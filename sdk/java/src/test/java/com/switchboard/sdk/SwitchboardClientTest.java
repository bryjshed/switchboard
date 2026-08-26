package com.switchboard.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * The client against a real HTTP server (the JDK's, so no test dependency).
 *
 * <p>The emphasis is the fail-safe behaviour, because that is what distinguishes a flag SDK
 * that is safe to deploy from one that can take an application down. Every case here asserts
 * that the caller still gets a usable value.
 */
class SwitchboardClientTest {

    private HttpServer server;
    private String baseUri;
    private final AtomicReference<String> bootstrapBody = new AtomicReference<>();
    private final AtomicInteger bootstrapStatus = new AtomicInteger(200);
    private final AtomicInteger bootstrapCalls = new AtomicInteger();
    private final AtomicReference<String> lastIfNoneMatch = new AtomicReference<>();

    private static final String PAYLOAD = """
        {"envKey":"production","stateVersion":42,"segments":[],"flags":[
          {"key":"bool-on","kind":"BOOLEAN","enabled":true,"killSwitchActive":false,"version":1,
           "variations":[{"id":"0a0a0a0a-0000-4000-8000-000000000001","value":"true"},
                         {"id":"0a0a0a0a-0000-4000-8000-000000000002","value":"false"}],
           "config":{"individualTargets":[],"rules":[],
             "fallthrough":{"variationId":"0a0a0a0a-0000-4000-8000-000000000001"},
             "offVariationId":"0a0a0a0a-0000-4000-8000-000000000002",
             "defaultVariationId":"0a0a0a0a-0000-4000-8000-000000000001"}},
          {"key":"killed","kind":"BOOLEAN","enabled":true,"killSwitchActive":true,"version":1,
           "variations":[{"id":"0a0a0a0a-0000-4000-8000-000000000001","value":"true"},
                         {"id":"0a0a0a0a-0000-4000-8000-000000000002","value":"false"}],
           "config":{"individualTargets":[],"rules":[],
             "fallthrough":{"variationId":"0a0a0a0a-0000-4000-8000-000000000001"},
             "offVariationId":"0a0a0a0a-0000-4000-8000-000000000002",
             "defaultVariationId":"0a0a0a0a-0000-4000-8000-000000000001"}},
          {"key":"not-a-number","kind":"STRING","enabled":true,"killSwitchActive":false,"version":1,
           "variations":[{"id":"0a0a0a0a-0000-4000-8000-000000000003","value":"banana"}],
           "config":{"individualTargets":[],"rules":[],
             "fallthrough":{"variationId":"0a0a0a0a-0000-4000-8000-000000000003"},
             "offVariationId":"0a0a0a0a-0000-4000-8000-000000000003",
             "defaultVariationId":"0a0a0a0a-0000-4000-8000-000000000003"}},
          {"key":"json-flag","kind":"STRING","enabled":true,"killSwitchActive":false,"version":1,
           "variations":[{"id":"0a0a0a0a-0000-4000-8000-000000000004","value":"{\\"tier\\":\\"gold\\"}"}],
           "config":{"individualTargets":[],"rules":[],
             "fallthrough":{"variationId":"0a0a0a0a-0000-4000-8000-000000000004"},
             "offVariationId":"0a0a0a0a-0000-4000-8000-000000000004",
             "defaultVariationId":"0a0a0a0a-0000-4000-8000-000000000004"}}]}
        """;

    @BeforeEach
    void startServer() throws IOException {
        bootstrapBody.set(PAYLOAD);
        bootstrapStatus.set(200);
        bootstrapCalls.set(0);
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/eval/bootstrap", this::handleBootstrap);
        // The stream is accepted and then held open with no events, so the client's update
        // loop has somewhere to connect without affecting what these tests assert.
        server.createContext("/api/stream", exchange -> {
            exchange.getResponseHeaders().add("Content-Type", "text/event-stream");
            exchange.sendResponseHeaders(200, 0);
        });
        server.start();
        baseUri = "http://127.0.0.1:" + server.getAddress().getPort();
    }

    private void handleBootstrap(HttpExchange exchange) throws IOException {
        bootstrapCalls.incrementAndGet();
        lastIfNoneMatch.set(exchange.getRequestHeaders().getFirst("If-None-Match"));
        int status = bootstrapStatus.get();
        if (status != 200) {
            exchange.sendResponseHeaders(status, -1);
            exchange.close();
            return;
        }
        byte[] body = bootstrapBody.get().getBytes(StandardCharsets.UTF_8);
        exchange.getResponseHeaders().add("ETag", "\"42\"");
        exchange.getResponseHeaders().add("Content-Type", "application/json");
        exchange.sendResponseHeaders(200, body.length);
        exchange.getResponseBody().write(body);
        exchange.close();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private SwitchboardClient client() {
        return new SwitchboardClient(SwitchboardConfig.builder("sb_srv_test").baseUri(baseUri).build());
    }

    @Test
    void loadsAndEvaluatesLocally() {
        try (var client = client()) {
            client.start();
            assertTrue(client.isReady());
            assertEquals(42L, client.stateVersion());
            assertTrue(client.booleanValue("bool-on", false, EvalContexts.of("user-1")).value());
        }
    }

    @Test
    void killSwitchServesTheOffVariation() {
        try (var client = client()) {
            client.start();
            var detail = client.booleanValue("killed", true, EvalContexts.of("user-1"));
            assertFalse(detail.value());
            assertEquals("KILL_SWITCH", detail.reason().name());
        }
    }

    @Test
    void anUnknownFlagServesTheCallersDefault() {
        // The fail-safe. A flag system that throws on an unrecognised key is worse than none.
        try (var client = client()) {
            client.start();
            var detail = client.booleanValue("no-such-flag", true, EvalContexts.of("user-1"));
            assertTrue(detail.value(), "the caller's default must come back");
            assertEquals(EvaluationDetail.ErrorKind.FLAG_NOT_FOUND, detail.errorKind());
        }
    }

    @Test
    void anUnparseableValueServesTheCallersDefault() {
        try (var client = client()) {
            client.start();
            var detail = client.doubleValue("not-a-number", 1.5, EvalContexts.of("user-1"));
            assertEquals(1.5, detail.value());
            assertEquals(EvaluationDetail.ErrorKind.PARSE_ERROR, detail.errorKind());
        }
    }

    @Test
    void parsesAJsonVariation() {
        try (var client = client()) {
            client.start();
            var detail = client.jsonValue("json-flag", null, EvalContexts.of("user-1"));
            assertNotNull(detail.value());
            assertEquals("gold", detail.value().path("tier").asText());
        }
    }

    @Test
    void aNullContextIsReportedRatherThanBucketedOnNothing() {
        // How the provider represents "no targeting key" - see SwitchboardProvider, which
        // maps a blank key to null precisely so this path is taken instead of an exception
        // being thrown through the caller's flag check.
        try (var client = client()) {
            client.start();
            var detail = client.booleanValue("bool-on", false, null);
            assertEquals(EvaluationDetail.ErrorKind.INVALID_CONTEXT, detail.errorKind());
            assertFalse(detail.value());
        }
    }

    @Test
    void theContextBuilderRejectsABlankKeyAtTheCallSite() {
        // Deliberately different from the provider path above: a caller writing
        // EvalContexts.of("") by hand has a bug, and failing at the call site names it.
        // Degrading is right when the context comes from a framework, not from this line.
        org.junit.jupiter.api.Assertions.assertThrows(IllegalArgumentException.class,
            () -> EvalContexts.of(""));
    }

    @Test
    void anUnreachableServerStillStartsAndServesDefaults() {
        // The most important test here. Switchboard being down must degrade the application,
        // not stop it: start() returns, isReady() tells the truth, evaluation still answers.
        var config = SwitchboardConfig.builder("sb_srv_test")
            .baseUri("http://127.0.0.1:1")            // nothing listens here
            .startTimeout(java.time.Duration.ofMillis(300))
            .build();
        try (var client = new SwitchboardClient(config)) {
            client.start();
            assertFalse(client.isReady(), "readiness must report the truth");
            var detail = client.booleanValue("anything", true, EvalContexts.of("user-1"));
            assertTrue(detail.value(), "the caller's default must still come back");
            assertEquals(EvaluationDetail.ErrorKind.CLIENT_NOT_READY, detail.errorKind());
        }
    }

    @Test
    void failFastOnStartIsOptInAndThrowsWhenAsked() {
        var config = SwitchboardConfig.builder("sb_srv_test")
            .baseUri("http://127.0.0.1:1")
            .startTimeout(java.time.Duration.ofMillis(300))
            .failFastOnStart(true)
            .build();
        try (var client = new SwitchboardClient(config)) {
            org.junit.jupiter.api.Assertions.assertThrows(IllegalStateException.class, client::start);
        }
    }

    @Test
    void aFailedRefreshKeepsTheConfigurationAlreadyHeld() throws Exception {
        // Losing contact must never mean losing the flags we already have. Polling mode with a
        // short interval so a real failed refresh actually happens inside the test.
        var config = SwitchboardConfig.builder("sb_srv_test").baseUri(baseUri)
            .mode(SwitchboardConfig.UpdateMode.POLLING)
            .pollInterval(java.time.Duration.ofMillis(30))
            .build();
        try (var client = new SwitchboardClient(config)) {
            client.start();
            assertTrue(client.booleanValue("bool-on", false, EvalContexts.of("u")).value());

            int before = bootstrapCalls.get();
            bootstrapStatus.set(500);
            // Wait for at least two refreshes to have failed, so this is not a race.
            for (int i = 0; i < 100 && bootstrapCalls.get() < before + 2; i++) {
                Thread.sleep(20);
            }
            assertTrue(bootstrapCalls.get() >= before + 2, "expected the poll loop to have retried and failed");

            assertTrue(client.isReady(), "a failed refresh must not un-ready a loaded client");
            assertTrue(client.booleanValue("bool-on", false, EvalContexts.of("u")).value(),
                "the previously-loaded configuration must still answer");
        }
    }

    @Test
    void sendsIfNoneMatchOnceAnEtagIsHeld() throws Exception {
        // The 304 path is what makes a short poll interval cheap; if the ETag were not sent
        // back, every poll would transfer the whole payload and nothing would fail loudly.
        var config = SwitchboardConfig.builder("sb_srv_test").baseUri(baseUri)
            .mode(SwitchboardConfig.UpdateMode.POLLING)
            .pollInterval(java.time.Duration.ofMillis(30))
            .build();
        try (var client = new SwitchboardClient(config)) {
            client.start();
            assertNull(lastIfNoneMatch.get(), "the very first fetch has no ETag to send");

            for (int i = 0; i < 100 && lastIfNoneMatch.get() == null; i++) {
                Thread.sleep(20);
            }
            assertEquals("\"42\"", lastIfNoneMatch.get(),
                "the ETag from the first response must be echoed on the next request");
        }
    }

    @Test
    void allFlagsEvaluatesEveryFlagForOneContext() {
        try (var client = client()) {
            client.start();
            var all = client.allFlags(EvalContexts.of("user-1"));
            assertEquals(4, all.size());
            assertEquals("true", all.get("bool-on").value());
            assertEquals("false", all.get("killed").value());
        }
    }
}
