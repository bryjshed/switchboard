package com.switchboard.infrastructure.identity;

import com.switchboard.domain.identity.IdentityProviderPort;
import com.switchboard.domain.identity.IdentityVerificationException;
import com.switchboard.domain.identity.VerifiedIdentity;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtClaimNames;
import org.springframework.security.oauth2.jwt.JwtClaimValidator;
import org.springframework.security.oauth2.jwt.JwtIssuerValidator;
import org.springframework.security.oauth2.jwt.JwtValidators;
import org.springframework.security.oauth2.jwt.NimbusReactiveJwtDecoder;
import org.springframework.security.oauth2.jwt.ReactiveJwtDecoder;
import reactor.core.publisher.Mono;

/**
 * The general case: any issuer that signs OIDC ID tokens and publishes a JWKS.
 *
 * <p>That is Auth0, Okta, Entra ID, Keycloak, Cognito, Google - and Firebase in production, whose
 * ID tokens are ordinary RS256 JWTs from {@code https://securetoken.google.com/<projectId>}. One
 * adapter covers all of them, which is the whole argument for this refactor: the differences
 * between IdPs are configuration (issuer, audience, claim names), not code.
 *
 * <p>Verification is Spring Security's {@link NimbusReactiveJwtDecoder} rather than a hand-rolled
 * check or a third-party JWT library. It is already in the Spring ecosystem this service is built
 * on, it fetches and caches the JWKS and refetches when a token arrives with a {@code kid} the
 * cached set does not contain, and its validators for {@code iss}, {@code exp} and {@code nbf}
 * are the ones the framework maintains. We add the {@code aud} check and a TTL on top.
 *
 * <p>The decoder is built lazily and rebuilt once {@code jwkCacheTtl} has elapsed. Lazily, because
 * OIDC discovery is a network call and an IdP being briefly unreachable must not stop the service
 * from starting; rebuilt, because the kid-miss refresh alone would hold a withdrawn key forever.
 */
public class OidcIdentityProvider implements IdentityProviderPort {

    private static final String EMAIL_VERIFIED_TRUE = "true";

    private final String issuer;
    private final String jwkSetUri;
    private final String audience;
    private final String emailClaim;
    private final String nameClaim;
    private final String emailVerifiedClaim;
    private final long ttlNanos;

    private volatile CachedDecoder cached;

    public OidcIdentityProvider(
        String issuer,
        String jwkSetUri,
        String audience,
        String emailClaim,
        String nameClaim,
        String emailVerifiedClaim,
        Duration jwkCacheTtl) {
        this.issuer = issuer;
        this.jwkSetUri = jwkSetUri;
        this.audience = audience;
        this.emailClaim = emailClaim;
        this.nameClaim = nameClaim;
        this.emailVerifiedClaim = emailVerifiedClaim;
        this.ttlNanos = jwkCacheTtl.toNanos();
    }

    public String issuer() {
        return issuer;
    }

    @Override
    public Mono<VerifiedIdentity> verify(String rawToken) {
        return Mono.defer(() -> decoder().decode(rawToken))
            .onErrorMap(error -> new IdentityVerificationException(
                "Token rejected by " + issuer + ": " + error.getMessage(), error))
            .map(this::toIdentity);
    }

    private VerifiedIdentity toIdentity(Jwt jwt) {
        String email = jwt.getClaimAsString(emailClaim);
        if (email == null || email.isBlank()) {
            throw new IdentityVerificationException(
                "Token from " + issuer + " carries no '" + emailClaim + "' claim");
        }
        String displayName = jwt.getClaimAsString(nameClaim);
        return new VerifiedIdentity(
            issuer,
            jwt.getSubject(),
            email,
            displayName == null || displayName.isBlank() ? null : displayName,
            emailVerified(jwt));
    }

    /** Providers disagree on the type: a boolean in most, the string "true" in a few. */
    private boolean emailVerified(Jwt jwt) {
        Object claim = jwt.getClaim(emailVerifiedClaim);
        if (claim instanceof Boolean verified) {
            return verified;
        }
        return claim != null && EMAIL_VERIFIED_TRUE.equalsIgnoreCase(claim.toString().trim());
    }

    private ReactiveJwtDecoder decoder() {
        CachedDecoder current = cached;
        if (current != null && System.nanoTime() - current.builtAt() < ttlNanos) {
            return current.decoder();
        }
        ReactiveJwtDecoder fresh = build();
        cached = new CachedDecoder(fresh, System.nanoTime());
        return fresh;
    }

    private ReactiveJwtDecoder build() {
        NimbusReactiveJwtDecoder decoder = jwkSetUri == null || jwkSetUri.isBlank()
            ? NimbusReactiveJwtDecoder.withIssuerLocation(issuer).build()
            : NimbusReactiveJwtDecoder.withJwkSetUri(jwkSetUri).build();
        decoder.setJwtValidator(validator());
        return decoder;
    }

    /** Defaults cover exp and nbf (with the framework's clock skew); we add iss and aud. */
    private OAuth2TokenValidator<Jwt> validator() {
        List<OAuth2TokenValidator<Jwt>> validators = new ArrayList<>();
        validators.add(new JwtIssuerValidator(issuer));
        if (audience != null && !audience.isBlank()) {
            validators.add(new JwtClaimValidator<List<String>>(
                JwtClaimNames.AUD, claim -> claim != null && claim.contains(audience)));
        }
        return JwtValidators.createDefaultWithValidators(validators);
    }

    private record CachedDecoder(ReactiveJwtDecoder decoder, long builtAt) {
    }
}
