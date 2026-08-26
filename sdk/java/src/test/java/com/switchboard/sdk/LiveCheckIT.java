package com.switchboard.sdk;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.switchboard.domain.evaluation.EvalContext;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
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
 *     ./mvnw -pl sdk/java test -Dtest=LiveCheckIT
 * </pre>
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
}
