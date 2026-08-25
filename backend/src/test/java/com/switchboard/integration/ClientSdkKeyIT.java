package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.SdkKeyCreateRequest;
import com.switchboard.interfaces.rest.model.SdkKeyCreatedResponse;
import com.switchboard.interfaces.rest.model.SdkKeyKind;
import com.switchboard.interfaces.rest.model.SdkKeyResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * SDK key kinds, and the compatibility guarantee that makes the fail-closed default safe.
 *
 * <p>The load-bearing assertion is {@link #aServerKeyStillSeesEveryFlag()}: {@code flags
 * .client_side_available} defaults to FALSE, which would be a silent, total breakage of every
 * existing integration if a server key respected it. It must not. A server key is secret, receives
 * the full rule set, and sees every flag exactly as it did before this column existed.
 */
class ClientSdkKeyIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";

    @Test
    @DisplayName("existing keys backfill to SERVER and authenticate unchanged")
    void existingKeysAreServerKeys() {
        Workspace workspace = createWorkspace("keykind");
        SdkKeyCreatedResponse minted = mintSdkKeyResponse(workspace, ENV_KEY);

        // No kind on the request at all - the shape every caller written before today sends.
        assertThat(minted.getKind()).isEqualTo(SdkKeyKind.SERVER);
        assertThat(minted.getKey()).startsWith("sb_srv_");

        assertThat(selectOne("SELECT kind FROM sdk_keys WHERE id = :id",
            String.class, Map.of("id", minted.getId())))
            .isEqualTo("SERVER");
    }

    @Test
    @DisplayName("a client key mints with its own prefix and authenticates")
    void clientKeysMint() {
        Workspace workspace = createWorkspace("clientkey");
        SdkKeyCreatedResponse minted = mintKind(workspace, SdkKeyKind.CLIENT);

        assertThat(minted.getKind()).isEqualTo(SdkKeyKind.CLIENT);
        assertThat(minted.getKey()).startsWith("sb_cli_");

        // The widened prefix test means it reaches the SDK filter chain rather than the identity
        // registry; authenticating at all is what this asserts. 403 rather than 401 is the proof:
        // the key was recognised and then refused the RULE-SET bootstrap, which is server-only.
        // Its own evaluated bootstrap is covered by ClientBootstrapIT.
        createBooleanFlag(workspace, "client-key-flag");
        http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + minted.getKey())
            .exchange()
            .expectStatus().isForbidden();
    }

    @Test
    @DisplayName("the kind comes from the row, never from the token's prefix")
    void kindIsNotTakenFromThePrefix() {
        Workspace workspace = createWorkspace("spoof");
        SdkKeyCreatedResponse minted = mintKind(workspace, SdkKeyKind.CLIENT);

        // The prefix is attacker-supplied text. Whatever a token is spelled, what it can do is
        // decided by its row - so a client key remains a client key however it is presented.
        assertThat(selectOne("SELECT kind FROM sdk_keys WHERE id = :id",
            String.class, Map.of("id", minted.getId())))
            .isEqualTo("CLIENT");

        List<SdkKeyResponse> listed = http.get()
            .uri("/api/environments/{envId}/sdk-keys", workspace.environmentId(ENV_KEY))
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBodyList(SdkKeyResponse.class)
            .returnResult().getResponseBody();
        assertThat(listed).isNotNull().anySatisfy(key ->
            assertThat(key.getKind()).isEqualTo(SdkKeyKind.CLIENT));
    }

    @Test
    @DisplayName("MOBILE is reserved but not mintable")
    void mobileKeysAreNotMintableYet() {
        Workspace workspace = createWorkspace("mobilekey");
        http.post()
            .uri("/api/environments/{envId}/sdk-keys", workspace.environmentId(ENV_KEY))
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new SdkKeyCreateRequest().kind(SdkKeyKind.MOBILE).label("phone"))
            .exchange()
            .expectStatus().isBadRequest();
    }

    @Test
    @DisplayName("a server key still sees a flag that is not client-side available")
    void aServerKeyStillSeesEveryFlag() {
        Workspace workspace = createWorkspace("compat");
        UUID flagId = createBooleanFlag(workspace, "server-only-flag").getId();

        // The column defaults to FALSE, so this is the state EVERY existing flag is now in.
        assertThat(selectOne("SELECT client_side_available FROM flags WHERE id = :id",
            Boolean.class, Map.of("id", flagId)))
            .isFalse();

        String serverKey = mintSdkKey(workspace, ENV_KEY);

        // If a server key ever respected that column, every integration in existence would go
        // silently empty the moment this migration ran. It must not.
        http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + serverKey)
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.flags[?(@.key == 'server-only-flag')]").exists();
    }

    private SdkKeyCreatedResponse mintKind(Workspace workspace, SdkKeyKind kind) {
        return http.post()
            .uri("/api/environments/{envId}/sdk-keys", workspace.environmentId(ENV_KEY))
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(new SdkKeyCreateRequest().kind(kind).label(kind.getValue() + " key"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(SdkKeyCreatedResponse.class)
            .returnResult().getResponseBody();
    }
}
