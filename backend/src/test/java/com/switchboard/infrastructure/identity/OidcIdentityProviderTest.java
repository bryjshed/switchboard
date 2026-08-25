package com.switchboard.infrastructure.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.switchboard.domain.identity.IdentityVerificationException;
import com.switchboard.domain.identity.VerifiedIdentity;
import com.switchboard.testsupport.TestOidcIssuer;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

/**
 * The generic OIDC adapter against a real signed issuer, with no Firebase anywhere near it.
 */
class OidcIdentityProviderTest {

    private static final String AUDIENCE = "switchboard";

    private static TestOidcIssuer issuer;

    @BeforeAll
    static void startIssuer() {
        issuer = new TestOidcIssuer();
    }

    @AfterAll
    static void stopIssuer() {
        issuer.close();
    }

    private static OidcIdentityProvider provider() {
        return provider("email", "name", "email_verified");
    }

    private static OidcIdentityProvider provider(String email, String name, String verified) {
        return new OidcIdentityProvider(issuer.issuer(), issuer.jwkSetUri(), AUDIENCE,
            email, name, verified, Duration.ofMinutes(15));
    }

    @Test
    void verifiesASignedTokenAndMapsTheStandardClaims() {
        String token = issuer.mint("user-1", AUDIENCE, Map.of(
            "email", "ada@example.com", "email_verified", true, "name", "Ada Lovelace"));

        VerifiedIdentity identity = provider().verify(token).block();

        assertThat(identity.issuer()).isEqualTo(issuer.issuer());
        assertThat(identity.subject()).isEqualTo("user-1");
        assertThat(identity.email()).isEqualTo("ada@example.com");
        assertThat(identity.displayName()).isEqualTo("Ada Lovelace");
        assertThat(identity.emailVerified()).isTrue();
    }

    @Test
    void claimNamesAreConfigurable() {
        // Entra ID and some Keycloak realms carry the name under preferred_username, and a few
        // IdPs still emit email_verified as a string.
        String token = issuer.mint("user-2", AUDIENCE, Map.of(
            "upn", "grace@example.com", "preferred_username", "Grace", "verified", "true"));

        VerifiedIdentity identity =
            provider("upn", "preferred_username", "verified").verify(token).block();

        assertThat(identity.email()).isEqualTo("grace@example.com");
        assertThat(identity.displayName()).isEqualTo("Grace");
        assertThat(identity.emailVerified()).isTrue();
    }

    @Test
    void rejectsAnExpiredToken() {
        String token = issuer.mint("user-3", AUDIENCE,
            Map.of("email", "old@example.com"), Instant.now().minusSeconds(3600));

        assertThatThrownBy(() -> provider().verify(token).block())
            .isInstanceOf(IdentityVerificationException.class);
    }

    @Test
    void rejectsATokenForAnotherAudience() {
        String token = issuer.mint("user-4", "some-other-app", Map.of("email", "x@example.com"));

        assertThatThrownBy(() -> provider().verify(token).block())
            .isInstanceOf(IdentityVerificationException.class);
    }

    @Test
    void rejectsATokenSignedByADifferentIssuersKey() {
        try (TestOidcIssuer impostor = new TestOidcIssuer()) {
            String token = impostor.mint("user-5", AUDIENCE, Map.of("email", "x@example.com"));

            // Same shape, different keys and a different iss: the signature check and the issuer
            // validator both have to say no.
            assertThatThrownBy(() -> provider().verify(token).block())
                .isInstanceOf(IdentityVerificationException.class);
        }
    }

    @Test
    void rejectsATokenWithNoEmailClaim() {
        String token = issuer.mint("user-6", AUDIENCE, Map.of("name", "Anonymous"));

        assertThatThrownBy(() -> provider().verify(token).block())
            .isInstanceOf(IdentityVerificationException.class)
            .hasMessageContaining("'email'");
    }

    @Test
    void treatsAMissingEmailVerifiedClaimAsUnverified() {
        String token = issuer.mint("user-7", AUDIENCE, Map.of("email", "quiet@example.com"));

        assertThat(provider().verify(token).block().emailVerified()).isFalse();
    }
}
