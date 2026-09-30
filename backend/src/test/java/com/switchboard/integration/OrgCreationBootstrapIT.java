package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.interfaces.rest.model.OrgCreateRequest;
import com.switchboard.interfaces.rest.model.UserResponse;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CompletableFuture;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.TestPropertySource;

/**
 * {@code switchboard.org-creation=bootstrap}, the self-hosted setting: the first person to sign in
 * creates the company's org, and nobody can create another after that.
 *
 * <p>One test method on purpose. Every IT class gets its own database, but the methods inside a
 * class share it, and "is this the first org?" is exactly the kind of state a second method would
 * inherit.
 */
@TestPropertySource(properties = "switchboard.org-creation=bootstrap")
class OrgCreationBootstrapIT extends IntegrationTestBase {

    @Test
    void onlyTheFirstUserMayCreateAnOrgAndTwoRacingFirstUsersProduceOne() {
        String first = uniqueEmail("first");
        String rival = uniqueEmail("rival");
        assertThat(signIn(first).getCanCreateOrg()).isTrue();
        assertThat(signIn(rival).getCanCreateOrg()).isTrue();

        // Both see "no org yet" and both try. The advisory lock makes exactly one of them win.
        List<Integer> statuses = List.of(first, rival).stream()
            .map(email -> CompletableFuture.supplyAsync(() -> createOrg(email, email + " Org")))
            .toList()
            .stream()
            .map(CompletableFuture::join)
            .sorted()
            .toList();
        assertThat(statuses).containsExactly(201, 403);
        assertThat(selectOne("SELECT count(*) FROM orgs", Long.class, Map.of())).isEqualTo(1L);

        // After that, nobody - including the winner - may create another, and /me says so.
        String latecomer = uniqueEmail("latecomer");
        UserResponse me = signIn(latecomer);
        assertThat(me.getCanCreateOrg()).isFalse();
        assertThat(signIn(first).getCanCreateOrg()).isFalse();

        http.post().uri("/api/orgs")
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(latecomer))
            .bodyValue(new OrgCreateRequest("Second Org"))
            .exchange()
            .expectStatus().isForbidden()
            .expectBody()
            .jsonPath("$.error").isEqualTo("FORBIDDEN")
            .jsonPath("$.message").value(message ->
                assertThat((String) message).contains("ask an admin for an invitation"));
        assertThat(createOrg(first, "Winner's Second Org")).isEqualTo(403);
        assertThat(selectOne("SELECT count(*) FROM orgs", Long.class, Map.of())).isEqualTo(1L);
    }

    private int createOrg(String email, String name) {
        return http.post().uri("/api/orgs")
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(email))
            .bodyValue(new OrgCreateRequest(name))
            .exchange()
            .returnResult(String.class)
            .getStatus()
            .value();
    }
}
