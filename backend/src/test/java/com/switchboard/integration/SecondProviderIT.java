package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.infrastructure.identity.IdentityProviderRegistry;
import com.switchboard.interfaces.rest.model.OrgCreateRequest;
import com.switchboard.interfaces.rest.model.OrgResponse;
import com.switchboard.interfaces.rest.model.UserResponse;
import com.switchboard.testsupport.TestOidcIssuer;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * The proof that authentication is no longer Firebase's.
 *
 * <p>A second issuer - its own RSA key pair, its own JWKS endpoint, signed RS256 tokens, an
 * issuer URL that has nothing to do with Google - is configured <em>alongside</em> the Firebase
 * provider, and a token it mints authenticates against the real API through the real filter chain.
 * Nothing about this issuer is special-cased anywhere in the codebase; it is entirely a few lines
 * of {@code switchboard.auth.providers} configuration, which is what "any identity provider" has
 * to mean to be worth claiming.
 *
 * <p>Swap the issuer URL and JWKS for Okta's, Auth0's, Entra ID's or Keycloak's and this test
 * describes that deployment instead.
 */
class SecondProviderIT extends IntegrationTestBase {

    private static final String AUDIENCE = "switchboard";
    private static final String FIREBASE_ISSUER = "https://securetoken.google.com/demo-switchboard";

    private static final TestOidcIssuer ISSUER = new TestOidcIssuer();

    @Autowired
    private IdentityProviderRegistry registry;

    @AfterAll
    static void stopIssuer() {
        ISSUER.close();
    }

    /**
     * Two providers, both live. Indexed list properties bind from one source, so the Firebase
     * provider that {@code application.yml} configures is restated here rather than inherited.
     */
    @DynamicPropertySource
    static void twoProviders(DynamicPropertyRegistry registry) {
        registry.add("switchboard.auth.providers[0].id", () -> "firebase-local");
        registry.add("switchboard.auth.providers[0].type", () -> "firebase");
        registry.add("switchboard.auth.providers[0].project-id", () -> "demo-switchboard");
        registry.add("switchboard.auth.providers[1].id", () -> "second-idp");
        registry.add("switchboard.auth.providers[1].type", () -> "oidc");
        registry.add("switchboard.auth.providers[1].issuer", ISSUER::issuer);
        registry.add("switchboard.auth.providers[1].jwk-set-uri", ISSUER::jwkSetUri);
        registry.add("switchboard.auth.providers[1].audience", () -> AUDIENCE);
    }

    @Test
    void bothProvidersAreActiveAtOnce() {
        assertThat(registry.issuers())
            .containsExactlyInAnyOrder(FIREBASE_ISSUER, ISSUER.issuer());
    }

    @Test
    void aTokenFromANonFirebaseIssuerAuthenticatesAgainstTheRealApi() {
        String email = uniqueEmail("okta-style");
        String subject = "second-idp|" + UUID.randomUUID();
        String token = ISSUER.mint(subject, AUDIENCE, Map.of(
            "email", email, "email_verified", true, "name", "Second Provider User"));

        UserResponse me = get("/api/users/me", token);

        assertThat(me.getEmail()).isEqualTo(email);
        assertThat(identityIssuers(me.getId())).containsExactly(ISSUER.issuer());

        // Not just /users/me: the whole management surface answers to this principal.
        OrgResponse org = http.post().uri("/api/orgs")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
            .bodyValue(new OrgCreateRequest("Second Provider Org"))
            .exchange()
            .expectStatus().isCreated()
            .expectBody(OrgResponse.class)
            .returnResult().getResponseBody();
        assertThat(org.getId()).isNotNull();
    }

    @Test
    void aSecondProviderJoinsAnExistingAccountRatherThanForkingIt() {
        String email = uniqueEmail("migrating-user");

        // The dev token stands in for the account that already exists: it provisions a row, and
        // the first real login for that address must adopt it.
        UUID existing = signIn(email).getId();

        String token = ISSUER.mint("second-idp|" + UUID.randomUUID(), AUDIENCE, Map.of(
            "email", email, "email_verified", true));
        UserResponse afterMigration = get("/api/users/me", token);

        assertThat(afterMigration.getId()).isEqualTo(existing);
        assertThat(identityIssuers(existing)).hasSize(2);
        assertThat(countByEmail(email)).isEqualTo(1);
    }

    @Test
    void aTokenFromAnIssuerNobodyConfiguredIs401() {
        try (TestOidcIssuer unconfigured = new TestOidcIssuer()) {
            String token = unconfigured.mint("someone", AUDIENCE, Map.of(
                "email", uniqueEmail("stranger"), "email_verified", true));

            http.get().uri("/api/users/me")
                .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
                .exchange()
                .expectStatus().isUnauthorized();
        }
    }

    @Test
    void aTokenTheSecondProviderRejectsIs401() {
        // Right issuer, wrong audience - the provider is found and refuses it.
        String token = ISSUER.mint("someone", "a-different-app", Map.of(
            "email", uniqueEmail("wrong-audience"), "email_verified", true));

        http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
            .exchange()
            .expectStatus().isUnauthorized();
    }

    private UserResponse get(String path, String token) {
        return http.get().uri(path)
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + token)
            .exchange()
            .expectStatus().isOk()
            .expectBody(UserResponse.class)
            .returnResult().getResponseBody();
    }

    private List<String> identityIssuers(UUID userId) {
        return selectColumn("SELECT issuer FROM user_identities WHERE user_id = :id ORDER BY linked_at",
            String.class, Map.of("id", userId));
    }

    private long countByEmail(String email) {
        return selectOne("SELECT count(*) FROM users WHERE email = :email",
            Long.class, Map.of("email", email));
    }
}
