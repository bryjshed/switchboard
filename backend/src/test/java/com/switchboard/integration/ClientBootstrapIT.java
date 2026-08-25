package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.BulkEvalRequest;
import com.switchboard.interfaces.rest.model.ClientBootstrapRequest;
import com.switchboard.interfaces.rest.model.ClientBootstrapResponse;
import com.switchboard.interfaces.rest.model.EvalContext;
import com.switchboard.interfaces.rest.model.FlagDetailResponse;
import com.switchboard.interfaces.rest.model.FlagUpdateRequest;
import com.switchboard.interfaces.rest.model.SdkKeyCreateRequest;
import com.switchboard.interfaces.rest.model.SdkKeyCreatedResponse;
import com.switchboard.interfaces.rest.model.SdkKeyKind;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.http.MediaType;

/**
 * The evaluated bootstrap, and what a public key can and cannot see.
 *
 * <p>{@link #theClientPayloadAgreesWithServerEvaluation()} is the one that keeps the conformance
 * vectors meaningful here. Client mode moves the SDK <em>off</em> the locally-evaluated path the
 * 201 vectors cover, so those vectors no longer say anything about what a client-mode SDK returns.
 * Asserting that this endpoint is a faithful projection of {@code POST /api/eval} restores that
 * coverage transitively, for the price of one test.
 */
class ClientBootstrapIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";

    @Test
    @DisplayName("a client payload carries values, never rules or segment membership")
    void theClientPayloadCarriesNoRules() {
        Workspace workspace = createWorkspace("clientboot");
        publish(workspace, createBooleanFlag(workspace, "visible-flag"));
        String clientKey = mintClientKey(workspace);

        String raw = http.post().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + clientKey)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(new ClientBootstrapRequest(context("user-1")))
            .exchange()
            .expectStatus().isOk()
            .expectBody(String.class)
            .returnResult().getResponseBody();

        assertThat(raw).isNotNull();
        // The exposure defect this whole phase exists to close: the rule-set bootstrap shipped
        // every segment's includedKeys, which are user ids or email addresses.
        assertThat(raw)
            .as("no targeting configuration or cohort membership may appear in a client payload")
            .doesNotContain("includedKeys")
            .doesNotContain("excludedKeys")
            .doesNotContain("segments")
            .doesNotContain("fallthrough")
            .doesNotContain("individualTargets")
            .doesNotContain("rules");
        // Nor the values of the arms that were not served.
        assertThat(raw).doesNotContain("variations");
    }

    @Test
    @DisplayName("a flag that is not client-side available is absent entirely")
    void hiddenFlagsAreAbsent() {
        Workspace workspace = createWorkspace("hidden");
        publish(workspace, createBooleanFlag(workspace, "published-flag"));
        createBooleanFlag(workspace, "secret-flag");           // left at the FALSE default
        String clientKey = mintClientKey(workspace);

        ClientBootstrapResponse payload = clientBootstrap(clientKey, "user-1");

        assertThat(payload.getFlags()).extracting("key").containsExactly("published-flag");

        // And it is not reachable one key at a time either - filtering only the bootstrap would
        // make clientSideAvailable a fig leaf, since the single-flag endpoint would still confirm
        // the flag exists and say what it serves.
        http.post().uri("/api/eval/{flagKey}", "secret-flag")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + clientKey)
            .bodyValue(Map.of("context", Map.of("key", "user-1"), "default", "fallback"))
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.value").isEqualTo("fallback")
            .jsonPath("$.reason").isEqualTo("SDK_DEFAULT");
    }

    @Test
    @DisplayName("the client payload agrees with server-side evaluation, flag for flag")
    void theClientPayloadAgreesWithServerEvaluation() {
        Workspace workspace = createWorkspace("agree");
        publish(workspace, createBooleanFlag(workspace, "agree-bool"));
        publish(workspace, createStringFlag(workspace, "agree-string", List.of("a", "b", "c")));
        String clientKey = mintClientKey(workspace);
        String serverKey = mintSdkKey(workspace, ENV_KEY);

        ClientBootstrapResponse client = clientBootstrap(clientKey, "user-42");

        // POST /api/eval is the path the 201 conformance vectors cover transitively.
        String serverEval = http.post().uri("/api/eval")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + serverKey)
            .bodyValue(new BulkEvalRequest(context("user-42")))
            .exchange()
            .expectStatus().isOk()
            .expectBody(String.class)
            .returnResult().getResponseBody();

        assertThat(client.getFlags()).isNotEmpty();
        client.getFlags().forEach(flag -> assertThat(serverEval)
            .as("client and server must agree on %s", flag.getKey())
            .contains("\"" + flag.getKey() + "\"")
            .contains("\"" + flag.getValue() + "\""));
    }

    @Test
    @DisplayName("the ETag covers the context, not just the environment version")
    void theEtagIsContextDependent() {
        Workspace workspace = createWorkspace("etag");
        publish(workspace, createStringFlag(workspace, "etag-flag", List.of("a", "b")));
        String clientKey = mintClientKey(workspace);

        String first = etagFor(clientKey, "user-1");
        String same = etagFor(clientKey, "user-1");
        String other = etagFor(clientKey, "user-2");

        assertThat(first).isEqualTo(same);
        // A stateVersion ETag would make these identical, and any shared cache could then serve
        // one user's evaluated flags to another.
        assertThat(first).isNotEqualTo(other);

        // A matching ETag still short-circuits, so the conditional path is not merely disabled.
        http.post().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + clientKey)
            .header(HttpHeaders.IF_NONE_MATCH, first)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(new ClientBootstrapRequest(context("user-1")))
            .exchange()
            .expectStatus().isNotModified()
            .expectHeader().cacheControl(org.springframework.http.CacheControl.noStore().cachePrivate());
    }

    @Test
    @DisplayName("a client key is refused the rule-set bootstrap outright")
    void theRuleSetBootstrapIsServerOnly() {
        Workspace workspace = createWorkspace("ruleset");
        publish(workspace, createBooleanFlag(workspace, "ruleset-flag"));
        String clientKey = mintClientKey(workspace);

        // 403, not a quietly reduced 200: a smaller-than-expected payload is how an SDK ends up
        // serving defaults forever with nothing surfaced.
        http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + clientKey)
            .exchange()
            .expectStatus().isForbidden();

        // The server key's path is untouched.
        http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + mintSdkKey(workspace, ENV_KEY))
            .exchange()
            .expectStatus().isOk();
    }

    @Test
    @DisplayName("a client key cannot report metric events")
    void metricEventsAreRefusedForClientKeys() {
        Workspace workspace = createWorkspace("metrics-guard");
        String clientKey = mintClientKey(workspace);

        // Metric events feed the automated rollback path, so accepting them from a key anyone can
        // read out of a JavaScript bundle would be accepting unauthenticated flag changes.
        http.post().uri("/api/events/metrics")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + clientKey)
            .bodyValue(Map.of("events", List.of(Map.of(
                "contextKey", "user-1", "metricKey", "error", "value", 1,
                "occurredAt", "2026-08-24T12:00:00Z"))))
            .exchange()
            .expectStatus().isForbidden();

        // Eval events stay open: rates are per distinct subject, so forging them inflates a
        // denominator and makes the monitor less likely to act, not more.
        http.post().uri("/api/events/eval")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + clientKey)
            .bodyValue(Map.of("events", List.of(Map.of(
                "contextKey", "user-1", "flagKey", "any", "reason", "ROLLOUT",
                "occurredAt", "2026-08-24T12:00:00Z"))))
            .exchange()
            .expectStatus().isAccepted();
    }

    // ---------------------------------------------------------------- fixtures

    private static EvalContext context(String key) {
        return new EvalContext(key).attributes(Map.of("plan", "pro"));
    }

    private String etagFor(String clientKey, String contextKey) {
        return http.post().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + clientKey)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(new ClientBootstrapRequest(context(contextKey)))
            .exchange()
            .expectStatus().isOk()
            .expectHeader().exists(HttpHeaders.ETAG)
            .returnResult(String.class)
            .getResponseHeaders().getETag();
    }

    private ClientBootstrapResponse clientBootstrap(String clientKey, String contextKey) {
        return http.post().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + clientKey)
            .contentType(MediaType.APPLICATION_JSON)
            .bodyValue(new ClientBootstrapRequest(context(contextKey)))
            .exchange()
            .expectStatus().isOk()
            .expectBody(ClientBootstrapResponse.class)
            .returnResult().getResponseBody();
    }

    /** Marks a flag client-side available, which is off by default. */
    private void publish(Workspace workspace, FlagDetailResponse flag) {
        http.patch()
            .uri("/api/projects/{projectId}/flags/{flagKey}", workspace.projectId(), flag.getKey())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new FlagUpdateRequest().clientSideAvailable(true))
            .exchange()
            .expectStatus().isOk();
    }

    private String mintClientKey(Workspace workspace) {
        SdkKeyCreatedResponse created = http.post()
            .uri("/api/environments/{envId}/sdk-keys", workspace.environmentId(ENV_KEY))
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new SdkKeyCreateRequest().kind(SdkKeyKind.CLIENT).label("browser"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(SdkKeyCreatedResponse.class)
            .returnResult().getResponseBody();
        return created.getKey();
    }
}
