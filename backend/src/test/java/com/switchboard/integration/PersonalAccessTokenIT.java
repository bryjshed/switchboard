package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.PersonalAccessTokenCreatedResponse;
import com.switchboard.interfaces.rest.model.PersonalAccessTokenResponse;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;

/**
 * Personal access tokens: non-interactive auth for the management API.
 *
 * <p>The property that matters most is {@link #aTokenInheritsItsOwnersPermissionsExactly()}. A
 * token authenticates <em>as its owner</em> and runs through the same RBAC every browser request
 * does - there is deliberately no second authorization model, because a parallel one would be a
 * second place for a permission bug to live and would only be exercised by whoever used a token.
 */
class PersonalAccessTokenIT extends IntegrationTestBase {

    @Test
    @DisplayName("a token authenticates, and its full value is returned exactly once")
    void mintAndUse() {
        Workspace workspace = createWorkspace("pat");
        PersonalAccessTokenCreatedResponse created = mint(workspace, "ci", null);

        assertThat(created.getToken()).startsWith("sb_pat_");
        assertThat(created.getTokenPrefix())
            .as("display prefix is never enough to authenticate with")
            .doesNotContain(created.getToken());

        http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + created.getToken())
            .exchange()
            .expectStatus().isOk()
            .expectBody()
            .jsonPath("$.email").isEqualTo(workspace.ownerEmail());

        // Listing never returns the secret again - only the hash is stored.
        List<PersonalAccessTokenResponse> listed = list(workspace);
        assertThat(listed).isNotNull().hasSize(1);
        assertThat(listed.get(0).getTokenPrefix()).isEqualTo(created.getTokenPrefix());
        assertThat(selectOne("SELECT count(*) FROM personal_access_tokens WHERE token_prefix = :p",
            Long.class, Map.of("p", created.getTokenPrefix())))
            .isEqualTo(1);
    }

    @Test
    @DisplayName("a token inherits its owner's permissions exactly, no more and no less")
    void aTokenInheritsItsOwnersPermissionsExactly() {
        Workspace owner = createWorkspace("pat-owner");
        Workspace outsider = createWorkspace("pat-outsider");

        PersonalAccessTokenCreatedResponse token = mint(owner, "agent", null);
        String auth = "Bearer " + token.getToken();

        // Everything the owner can do.
        http.post().uri("/api/projects/{projectId}/flags", owner.projectId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .bodyValue(Map.of("key", "pat-made-this", "name", "PAT made this", "kind", "BOOLEAN"))
            .exchange()
            .expectStatus().isCreated();

        // And nothing they cannot: the token is not a privilege escalation.
        http.get().uri("/api/projects/{projectId}/flags", outsider.projectId())
            .header(HttpHeaders.AUTHORIZATION, auth)
            .exchange()
            .expectStatus().isForbidden();
    }

    @Test
    @DisplayName("a revoked token stops working immediately")
    void revocationWorks() {
        Workspace workspace = createWorkspace("pat-revoke");
        PersonalAccessTokenCreatedResponse created = mint(workspace, "temporary", null);
        String auth = "Bearer " + created.getToken();

        http.get().uri("/api/users/me").header(HttpHeaders.AUTHORIZATION, auth)
            .exchange().expectStatus().isOk();

        http.delete().uri("/api/users/me/tokens/{id}", created.getId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isNoContent();

        http.get().uri("/api/users/me").header(HttpHeaders.AUTHORIZATION, auth)
            .exchange().expectStatus().isUnauthorized();

        // Still listed, marked revoked. A revocation should be visible, not a disappearance.
        assertThat(list(workspace)).hasSize(1).allSatisfy(t ->
            assertThat(t.getRevokedAt()).isNotNull());
    }

    @Test
    @DisplayName("an expired token is refused")
    void expiryWorks() {
        Workspace workspace = createWorkspace("pat-expiry");
        PersonalAccessTokenCreatedResponse created =
            mint(workspace, "short-lived", Instant.now().plus(1, ChronoUnit.HOURS));
        String auth = "Bearer " + created.getToken();

        http.get().uri("/api/users/me").header(HttpHeaders.AUTHORIZATION, auth)
            .exchange().expectStatus().isOk();

        // Move the clock rather than wait for it. Expiry is filtered in SQL, so there is no window
        // in which a caller holds a token object it is not allowed to use.
        execute("UPDATE personal_access_tokens SET expires_at = now() - interval '1 minute'"
            + " WHERE id = :id", Map.of("id", created.getId()));

        http.get().uri("/api/users/me").header(HttpHeaders.AUTHORIZATION, auth)
            .exchange().expectStatus().isUnauthorized();
    }

    @Test
    @DisplayName("one person cannot revoke another's token")
    void tokensArePersonal() {
        Workspace mine = createWorkspace("pat-mine");
        Workspace theirs = createWorkspace("pat-theirs");
        PersonalAccessTokenCreatedResponse token = mint(mine, "private", null);

        // 404 rather than 403: whether somebody else's token exists is not this caller's business.
        http.delete().uri("/api/users/me/tokens/{id}", token.getId())
            .header(HttpHeaders.AUTHORIZATION, theirs.authorization())
            .exchange()
            .expectStatus().isNotFound();

        http.get().uri("/api/users/me").header(HttpHeaders.AUTHORIZATION, "Bearer " + token.getToken())
            .exchange().expectStatus().isOk();
    }

    @Test
    @DisplayName("a nameless token is refused")
    void nameIsRequired() {
        Workspace workspace = createWorkspace("pat-noname");
        http.post().uri("/api/users/me/tokens")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(Map.of("name", "   "))
            .exchange()
            .expectStatus().isBadRequest();
    }

    @Test
    @DisplayName("a garbage token is rejected, not treated as an identity token")
    void garbageTokensAreRejected() {
        http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, "Bearer sb_pat_notarealtoken")
            .exchange()
            .expectStatus().isUnauthorized();
    }

    // ---------------------------------------------------------------- fixtures

    private PersonalAccessTokenCreatedResponse mint(
        Workspace workspace, String name, Instant expiresAt) {

        Map<String, Object> body = expiresAt == null
            ? Map.of("name", name)
            : Map.of("name", name, "expiresAt", expiresAt.toString());
        return http.post().uri("/api/users/me/tokens")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .bodyValue(body)
            .exchange()
            .expectStatus().isCreated()
            .expectBody(PersonalAccessTokenCreatedResponse.class)
            .returnResult().getResponseBody();
    }

    private List<PersonalAccessTokenResponse> list(Workspace workspace) {
        return http.get().uri("/api/users/me/tokens")
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isOk()
            .expectBodyList(PersonalAccessTokenResponse.class)
            .returnResult().getResponseBody();
    }
}
