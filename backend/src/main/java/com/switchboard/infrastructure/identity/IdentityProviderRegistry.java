package com.switchboard.infrastructure.identity;

import com.nimbusds.jwt.JWTParser;
import com.switchboard.domain.identity.IdentityProviderPort;
import com.switchboard.domain.identity.IdentityVerificationException;
import com.switchboard.domain.identity.VerifiedIdentity;
import java.text.ParseException;
import java.util.Map;
import java.util.Set;
import reactor.core.publisher.Mono;

/**
 * Decides which configured provider gets to verify a token, and rejects tokens no provider claims.
 *
 * <p>Routing is by the token's {@code iss} claim, read from the <b>unverified</b> payload. That is
 * safe for exactly one purpose - picking a verifier - and for nothing else: the selected provider
 * then checks the signature against that issuer's keys and validates {@code iss} itself, so a
 * forged issuer buys an attacker nothing but a different rejection. No claim read here is ever
 * passed on; {@link VerifiedIdentity} is built only from a decoded, verified token.
 *
 * <p>Dev tokens are matched by prefix before any parsing, because {@code dev:<email>} is not a JWT.
 *
 * <p>It is itself an {@link IdentityProviderPort}, which is what lets the security layer depend on
 * the domain port instead of on this class: composition of providers is an infrastructure concern
 * and nothing above it needs to know there is more than one.
 */
public class IdentityProviderRegistry implements IdentityProviderPort {

    private final Map<String, IdentityProviderPort> byIssuer;
    private final IdentityProviderPort devProvider;

    /**
     * @param byIssuer    the configured providers, keyed by the issuer each one speaks for
     * @param devProvider the local dev-token provider, or {@code null} when dev auth is off
     */
    public IdentityProviderRegistry(
        Map<String, IdentityProviderPort> byIssuer, IdentityProviderPort devProvider) {
        this.byIssuer = Map.copyOf(byIssuer);
        this.devProvider = devProvider;
    }

    public Set<String> issuers() {
        return byIssuer.keySet();
    }

    public boolean devAuthEnabled() {
        return devProvider != null;
    }

    @Override
    public Mono<VerifiedIdentity> verify(String rawToken) {
        if (rawToken.startsWith(DevTokenIdentityProvider.TOKEN_PREFIX)) {
            return devProvider == null
                ? Mono.error(new IdentityVerificationException("Dev tokens are disabled"))
                : devProvider.verify(rawToken);
        }
        return Mono.defer(() -> providerFor(unverifiedIssuer(rawToken)).verify(rawToken));
    }

    private IdentityProviderPort providerFor(String issuer) {
        IdentityProviderPort provider = byIssuer.get(issuer);
        if (provider == null) {
            throw new IdentityVerificationException(
                "No identity provider is configured for issuer '" + issuer + "'");
        }
        return provider;
    }

    private static String unverifiedIssuer(String rawToken) {
        try {
            String issuer = JWTParser.parse(rawToken).getJWTClaimsSet().getIssuer();
            if (issuer == null || issuer.isBlank()) {
                throw new IdentityVerificationException("Token carries no issuer claim");
            }
            return issuer;
        } catch (ParseException e) {
            throw new IdentityVerificationException("Bearer token is not a JWT", e);
        }
    }
}
