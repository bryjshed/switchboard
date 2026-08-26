package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import com.switchboard.domain.webhook.WebhookSigner;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.WebhookCreateRequest;
import com.switchboard.interfaces.rest.model.WebhookCreatedResponse;
import com.switchboard.interfaces.rest.model.WebhookEventType;
import java.io.IOException;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import org.awaitility.Awaitility;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * The whole webhook path against a real database and a real receiver: a flag write produces
 * a signed delivery, filters exclude what they should, and a failing receiver is retried
 * rather than dropped.
 */
class WebhookDeliveryIT extends IntegrationTestBase {

    private static final ObjectMapper JSON = new ObjectMapper();

    /** One captured request: everything a receiver would have to verify against. */
    private record Received(String body, Map<String, String> headers) {
    }

    private HttpServer receiver;
    private String receiverUrl;
    private final List<Received> received = new ArrayList<>();
    private final AtomicInteger failuresToServe = new AtomicInteger();

    @BeforeEach
    void startReceiver() throws IOException {
        received.clear();
        failuresToServe.set(0);
        receiver = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        receiver.createContext("/hook", this::handle);
        receiver.start();
        receiverUrl = "http://127.0.0.1:" + receiver.getAddress().getPort() + "/hook";
    }

    private void handle(HttpExchange exchange) throws IOException {
        String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
        Map<String, String> headers = new java.util.LinkedHashMap<>();
        exchange.getRequestHeaders().forEach((k, v) -> headers.put(k.toLowerCase(java.util.Locale.ROOT), v.getFirst()));
        synchronized (received) {
            received.add(new Received(body, headers));
        }
        int status = failuresToServe.getAndUpdate(n -> Math.max(0, n - 1)) > 0 ? 500 : 204;
        exchange.sendResponseHeaders(status, -1);
        exchange.close();
    }

    @AfterEach
    void stopReceiver() {
        receiver.stop(0);
    }

    private WebhookCreatedResponse createWebhook(Workspace workspace, WebhookCreateRequest request) {
        return http.post().uri("/api/orgs/{orgId}/webhooks", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(request)
            .exchange()
            .expectStatus().isCreated()
            .expectBody(WebhookCreatedResponse.class)
            .returnResult().getResponseBody();
    }

    private void awaitDeliveries(int count) {
        Awaitility.await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            synchronized (received) {
                assertThat(received).hasSizeGreaterThanOrEqualTo(count);
            }
        });
    }

    @Test
    void aFlagWriteProducesASignedDelivery() throws Exception {
        Workspace workspace = createWorkspace("wh-signed");
        WebhookCreatedResponse hook = createWebhook(workspace,
            new WebhookCreateRequest(receiverUrl));
        assertThat(hook.getSecret()).startsWith("whsec_");

        FlagDetailResponse flag = createBooleanFlag(workspace, "wh-flag");
        updateFlag(workspace, flag, "production");

        awaitDeliveries(1);
        Received delivery = received.getFirst();

        // The signature must verify with the secret the API handed back, using exactly the
        // recipe the OpenAPI description gives a consumer.
        assertThat(WebhookSigner.verify(hook.getSecret(), delivery.body(),
            delivery.headers().get("x-switchboard-signature"), Instant.now(), 300))
            .as("delivery must verify against the issued secret")
            .isTrue();

        assertThat(delivery.headers()).containsKey("x-switchboard-event-id");
        assertThat(delivery.headers().get("x-switchboard-event")).isEqualTo("flag.updated");

        JsonNode body = JSON.readTree(delivery.body());
        assertThat(body.path("type").asText()).isEqualTo("flag.updated");
        assertThat(body.path("data").path("flagKey").asText()).isEqualTo("wh-flag");
        assertThat(body.path("data").path("envKey").asText()).isEqualTo("production");
        assertThat(body.path("id").asText()).isNotEmpty();
    }

    @Test
    void aKillSwitchGetsItsOwnEventType() {
        Workspace workspace = createWorkspace("wh-kill");
        createWebhook(workspace, new WebhookCreateRequest(receiverUrl)
            .eventTypes(List.of(WebhookEventType.FLAG_KILL_SWITCH)));

        FlagDetailResponse flag = createBooleanFlag(workspace, "wh-kill-flag");
        // An ordinary update must NOT be delivered to a kill-switch-only hook...
        updateFlag(workspace, flag, "production");
        killSwitch(workspace, flag, "production", true);

        awaitDeliveries(1);
        synchronized (received) {
            assertThat(received).allSatisfy(r ->
                assertThat(r.headers().get("x-switchboard-event")).isEqualTo("flag.kill_switch"));
        }
    }

    @Test
    void anEnvironmentFilterExcludesOtherEnvironments() {
        Workspace workspace = createWorkspace("wh-env");
        createWebhook(workspace, new WebhookCreateRequest(receiverUrl)
            .environmentId(workspace.environmentId("production")));

        FlagDetailResponse flag = createBooleanFlag(workspace, "wh-env-flag");
        updateFlag(workspace, flag, "dev");
        updateFlag(workspace, flag, "production");

        awaitDeliveries(1);
        synchronized (received) {
            assertThat(received).hasSize(1);
        }
        // The dev write produced no delivery row at all, not merely an undelivered one.
        Long rows = selectOne("""
            SELECT count(*) FROM webhook_deliveries d
            JOIN webhooks w ON w.id = d.webhook_id
            WHERE w.org_id = :orgId
            """, Long.class, Map.of("orgId", workspace.orgId()));
        assertThat(rows).isEqualTo(1L);
    }

    @Test
    void aDisabledWebhookIsNotEnqueuedAtAll() {
        Workspace workspace = createWorkspace("wh-disabled");
        WebhookCreatedResponse hook = createWebhook(workspace, new WebhookCreateRequest(receiverUrl));
        http.patch().uri("/api/webhooks/{id}", hook.getId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("enabled", false))
            .exchange()
            .expectStatus().isOk();

        FlagDetailResponse flag = createBooleanFlag(workspace, "wh-off-flag");
        updateFlag(workspace, flag, "production");

        Long rows = selectOne("SELECT count(*) FROM webhook_deliveries WHERE webhook_id = :id",
            Long.class, Map.of("id", hook.getId()));
        assertThat(rows).isEqualTo(0L);
    }

    @Test
    void aFailingReceiverIsRetriedRatherThanDropped() {
        Workspace workspace = createWorkspace("wh-retry");
        WebhookCreatedResponse hook = createWebhook(workspace, new WebhookCreateRequest(receiverUrl));
        failuresToServe.set(1);          // the first attempt 500s

        FlagDetailResponse flag = createBooleanFlag(workspace, "wh-retry-flag");
        updateFlag(workspace, flag, "production");

        awaitDeliveries(1);

        // Still PENDING with a future next_attempt_at, rather than lost: this is the whole
        // point of the outbox. The sweep will pick it up; asserting on the ROW rather than
        // waiting 30s for the backoff keeps the test fast and deterministic.
        Awaitility.await().atMost(Duration.ofSeconds(10)).untilAsserted(() -> {
            String status = selectOne("SELECT status FROM webhook_deliveries WHERE webhook_id = :id",
                String.class, Map.of("id", hook.getId()));
            Integer attempts = selectOne("SELECT attempts FROM webhook_deliveries WHERE webhook_id = :id",
                Integer.class, Map.of("id", hook.getId()));
            assertThat(status).isEqualTo("PENDING");
            assertThat(attempts).isGreaterThanOrEqualTo(1);
        });

        Integer responseStatus = selectOne(
            "SELECT response_status FROM webhook_deliveries WHERE webhook_id = :id",
            Integer.class, Map.of("id", hook.getId()));
        assertThat(responseStatus).isEqualTo(500);
    }

    @Test
    void deliveriesAreVisibleThroughTheApi() {
        Workspace workspace = createWorkspace("wh-list");
        WebhookCreatedResponse hook = createWebhook(workspace, new WebhookCreateRequest(receiverUrl));
        FlagDetailResponse flag = createBooleanFlag(workspace, "wh-list-flag");
        updateFlag(workspace, flag, "production");
        awaitDeliveries(1);

        http.get().uri("/api/webhooks/{id}/deliveries", hook.getId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$[0].eventType").isEqualTo("flag.updated")
            .jsonPath("$[0].attempts").isNumber();
    }

    @Test
    void theSecretIsReturnedOnceAndNeverListed() {
        Workspace workspace = createWorkspace("wh-secret");
        createWebhook(workspace, new WebhookCreateRequest(receiverUrl));

        http.get().uri("/api/orgs/{orgId}/webhooks", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$[0].url").isEqualTo(receiverUrl)
            .jsonPath("$[0].secret").doesNotExist();
    }

    @Test
    void anotherOrgsMemberCannotSeeOrChangeAWebhook() {
        Workspace mine = createWorkspace("wh-mine");
        Workspace theirs = createWorkspace("wh-theirs");
        WebhookCreatedResponse hook = createWebhook(mine, new WebhookCreateRequest(receiverUrl));

        http.get().uri("/api/webhooks/{id}/deliveries", hook.getId())
            .header(HttpHeaders.AUTHORIZATION, theirs.authorization())
            .exchange()
            .expectStatus().isForbidden();

        http.delete().uri("/api/webhooks/{id}", hook.getId())
            .header(HttpHeaders.AUTHORIZATION, theirs.authorization())
            .exchange()
            .expectStatus().isForbidden();
    }

    @Test
    void anInvalidUrlIsRefused() {
        Workspace workspace = createWorkspace("wh-badurl");
        http.post().uri("/api/orgs/{orgId}/webhooks", workspace.orgId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("url", "ftp://example.test/hook"))
            .exchange()
            .expectStatus().isBadRequest();
    }

    // ---------------------------------------------------------------- helpers

    private void updateFlag(Workspace workspace, FlagDetailResponse flag, String envKey) {
        http.put().uri("/api/projects/{p}/flags/{k}/environments/{e}",
                workspace.projectId(), flag.getKey(), envKey)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(serveRequest(flag, envKey, "true",
                headVersion(flag.getId(), workspace.environmentId(envKey))))
            .exchange()
            .expectStatus().isOk();
    }

    private void killSwitch(Workspace workspace, FlagDetailResponse flag, String envKey, boolean active) {
        http.post().uri("/api/projects/{p}/flags/{k}/environments/{e}/kill-switch",
                workspace.projectId(), flag.getKey(), envKey)
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("active", active, "reason", "test"))
            .exchange()
            .expectStatus().isOk();
    }
}
