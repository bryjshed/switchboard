package com.switchboard.infrastructure.identity;

import com.switchboard.domain.identity.Identities;
import com.switchboard.domain.identity.IdentityProviderPort;
import com.switchboard.domain.identity.IdentityVerificationException;
import com.switchboard.domain.identity.VerifiedIdentity;
import reactor.core.publisher.Mono;

/**
 * {@code Bearer dev:<email>} - a password-free local credential, and the reason the seed script,
 * {@code scripts/smoke-test.mjs}, the SDK live-check and most of the integration suite can drive
 * the real filter chain without an IdP.
 *
 * <p>It is not an identity provider in any meaningful sense: it verifies nothing. It is gated on
 * {@code switchboard.security.dev-auth-enabled}, which only {@code application-local.yml} sets, and
 * it reports {@code emailVerified = false} because a dev token proves no email. Account linking
 * still works for it, by the separate dev-issuer clause in {@code UserService}.
 */
public class DevTokenIdentityProvider implements IdentityProviderPort {

    public static final String TOKEN_PREFIX = "dev:";

    @Override
    public Mono<VerifiedIdentity> verify(String rawToken) {
        return Mono.fromCallable(() -> {
            String email = rawToken.substring(TOKEN_PREFIX.length()).trim();
            if (email.isBlank()) {
                throw new IdentityVerificationException("Empty dev token email");
            }
            return new VerifiedIdentity(Identities.DEV_ISSUER, email, email, null, false);
        });
    }
}
