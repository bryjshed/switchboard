package com.switchboard.infrastructure.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.PlainJWT;
import com.switchboard.domain.identity.Identities;
import com.switchboard.domain.identity.IdentityProviderPort;
import com.switchboard.domain.identity.IdentityVerificationException;
import com.switchboard.domain.identity.VerifiedIdentity;
import java.util.Map;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;

/** Which provider gets the token, and what happens when none will take it. */
class IdentityProviderRegistryTest {

    private static final String OKTA = "https://example.okta.com/oauth2/default";
    private static final String AUTH0 = "https://example.auth0.com/";

    private static IdentityProviderPort stub(String issuer) {
        return token -> Mono.just(
            new VerifiedIdentity(issuer, "sub", "user@example.com", null, true));
    }

    private static String tokenFrom(String issuer) {
        return new PlainJWT(new JWTClaimsSet.Builder().issuer(issuer).build()).serialize();
    }

    private static IdentityProviderRegistry registry(boolean devAuth) {
        return new IdentityProviderRegistry(
            Map.of(OKTA, stub(OKTA), AUTH0, stub(AUTH0)),
            devAuth ? new DevTokenIdentityProvider() : null);
    }

    @Test
    void routesEachTokenToTheProviderThatClaimsItsIssuer() {
        // Both providers are active at once, which is what an org mid-IdP-migration needs.
        assertThat(registry(false).verify(tokenFrom(OKTA)).block().issuer()).isEqualTo(OKTA);
        assertThat(registry(false).verify(tokenFrom(AUTH0)).block().issuer()).isEqualTo(AUTH0);
    }

    @Test
    void rejectsATokenFromAnUnconfiguredIssuer() {
        assertThatThrownBy(
            () -> registry(false).verify(tokenFrom("https://stranger.example")).block())
            .isInstanceOf(IdentityVerificationException.class)
            .hasMessageContaining("https://stranger.example");
    }

    @Test
    void rejectsSomethingThatIsNotAJwtAtAll() {
        assertThatThrownBy(() -> registry(false).verify("garbage-token").block())
            .isInstanceOf(IdentityVerificationException.class)
            .hasMessageContaining("not a JWT");
    }

    @Test
    void rejectsAJwtWithNoIssuer() {
        String token = new PlainJWT(new JWTClaimsSet.Builder().subject("nobody").build())
            .serialize();

        assertThatThrownBy(() -> registry(false).verify(token).block())
            .isInstanceOf(IdentityVerificationException.class)
            .hasMessageContaining("no issuer");
    }

    @Test
    void devTokensAreMatchedByPrefixBeforeAnyParsing() {
        VerifiedIdentity identity = registry(true).verify("dev:ada@example.com").block();

        assertThat(identity.issuer()).isEqualTo(Identities.DEV_ISSUER);
        assertThat(identity.subject()).isEqualTo("ada@example.com");
        assertThat(identity.email()).isEqualTo("ada@example.com");
        // A dev token proves no email; UserService handles it under its own rule.
        assertThat(identity.emailVerified()).isFalse();
    }

    @Test
    void devTokensAreRefusedWhenDevAuthIsOff() {
        assertThatThrownBy(() -> registry(false).verify("dev:ada@example.com").block())
            .isInstanceOf(IdentityVerificationException.class)
            .hasMessageContaining("Dev tokens are disabled");
    }

    @Test
    void anEmptyDevTokenIsNotACredential() {
        assertThatThrownBy(() -> registry(true).verify("dev:").block())
            .isInstanceOf(IdentityVerificationException.class);
    }
}
