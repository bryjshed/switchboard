package com.switchboard.infrastructure.identity;

import com.switchboard.domain.identity.IdentityProviderPort;
import com.switchboard.domain.identity.VerifiedIdentity;
import java.time.Duration;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.util.ClassUtils;
import reactor.core.publisher.Mono;

/**
 * Firebase as one configured provider rather than a special case.
 *
 * <p>A Firebase ID token is an ordinary OIDC JWT: issuer
 * {@code https://securetoken.google.com/<projectId>}, audience {@code <projectId>}, RS256, keys at
 * Google's securetoken JWKS. So in production this class is a thin shell over
 * {@link OidcIdentityProvider} and behaves exactly as Okta or Auth0 would.
 *
 * <p>The exception is the local emulator, whose tokens are unsigned. When
 * {@code FIREBASE_AUTH_EMULATOR_HOST} is set, verification goes to
 * {@link FirebaseEmulatorTokenVerifier} and the Admin SDK, because nothing else can accept an
 * {@code alg: none} token. That is the entire remaining Firebase-specific surface.
 */
public class FirebaseIdentityProvider implements IdentityProviderPort {

    /** Google's shared JWKS for Firebase ID tokens; identical for every project. */
    public static final String SECURETOKEN_JWKS =
        "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

    private static final String ISSUER_PREFIX = "https://securetoken.google.com/";
    private static final String ADMIN_SDK_CLASS = "com.google.firebase.auth.FirebaseAuth";
    private static final Logger log = LoggerFactory.getLogger(FirebaseIdentityProvider.class);

    private final String issuer;
    private final IdentityProviderPort delegate;

    public FirebaseIdentityProvider(String projectId, String emulatorHost, Duration jwkCacheTtl) {
        this.issuer = issuerFor(projectId);
        this.delegate = delegate(projectId, emulatorHost, jwkCacheTtl);
    }

    public static String issuerFor(String projectId) {
        return ISSUER_PREFIX + projectId;
    }

    public String issuer() {
        return issuer;
    }

    private IdentityProviderPort delegate(String projectId, String emulatorHost, Duration ttl) {
        if (emulatorHost == null || emulatorHost.isBlank()) {
            return new OidcIdentityProvider(
                issuer, SECURETOKEN_JWKS, projectId, "email", "name", "email_verified", ttl);
        }
        if (!ClassUtils.isPresent(ADMIN_SDK_CLASS, getClass().getClassLoader())) {
            throw new IllegalStateException(
                "FIREBASE_AUTH_EMULATOR_HOST=" + emulatorHost + " but firebase-admin is not on the "
                    + "classpath. Emulator tokens are unsigned and only the Admin SDK will accept "
                    + "them: either add the optional firebase-admin dependency back, or unset the "
                    + "variable and point this provider at real Firebase.");
        }
        log.info("Firebase provider verifying emulator tokens for project {} via {}",
            projectId, emulatorHost);
        return new FirebaseEmulatorTokenVerifier(projectId, issuer);
    }

    @Override
    public Mono<VerifiedIdentity> verify(String rawToken) {
        return delegate.verify(rawToken);
    }
}
