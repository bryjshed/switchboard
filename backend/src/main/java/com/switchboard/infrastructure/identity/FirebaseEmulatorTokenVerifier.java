package com.switchboard.infrastructure.identity;

import com.google.auth.oauth2.AccessToken;
import com.google.auth.oauth2.GoogleCredentials;
import com.google.firebase.FirebaseApp;
import com.google.firebase.FirebaseOptions;
import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseToken;
import com.switchboard.domain.identity.IdentityProviderPort;
import com.switchboard.domain.identity.IdentityVerificationException;
import com.switchboard.domain.identity.VerifiedIdentity;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * The one place in the codebase that touches {@code firebase-admin}, and the only reason the
 * dependency still exists.
 *
 * <p>The Firebase Auth emulator issues <b>unsigned</b> tokens - {@code {"alg":"none"}} with an
 * empty signature - so no JWKS verifier can accept them, generic or otherwise. The Admin SDK
 * knows to skip signature verification when {@code FIREBASE_AUTH_EMULATOR_HOST} is set, and
 * still checks issuer, audience and expiry. Production Firebase never comes through here: it is
 * an ordinary OIDC issuer and {@link FirebaseIdentityProvider} routes it to
 * {@link OidcIdentityProvider}.
 *
 * <p>This class is loaded only when a {@code type: firebase} provider is configured <em>and</em>
 * the emulator host is set, so a deployment that authenticates against Okta never resolves these
 * classes and can drop the optional dependency outright.
 */
final class FirebaseEmulatorTokenVerifier implements IdentityProviderPort {

    private final String issuer;
    private final FirebaseAuth auth;

    FirebaseEmulatorTokenVerifier(String projectId, String issuer) {
        this.issuer = issuer;
        this.auth = firebaseAuth(projectId);
    }

    private static FirebaseAuth firebaseAuth(String projectId) {
        if (FirebaseApp.getApps().isEmpty()) {
            FirebaseApp.initializeApp(FirebaseOptions.builder()
                .setProjectId(projectId)
                // The emulator accepts any credential; it never checks this one.
                .setCredentials(GoogleCredentials.create(new AccessToken("emulator", null)))
                .build());
        }
        return FirebaseAuth.getInstance();
    }

    @Override
    public Mono<VerifiedIdentity> verify(String rawToken) {
        return Mono.fromCallable(() -> auth.verifyIdToken(rawToken))
            .subscribeOn(Schedulers.boundedElastic())
            .onErrorMap(error -> new IdentityVerificationException(
                "Token rejected by the Firebase emulator: " + error.getMessage(), error))
            .map(this::toIdentity);
    }

    private VerifiedIdentity toIdentity(FirebaseToken token) {
        String email = token.getEmail();
        if (email == null || email.isBlank()) {
            throw new IdentityVerificationException("Firebase token carries no email");
        }
        return new VerifiedIdentity(
            issuer, token.getUid(), email, token.getName(), token.isEmailVerified());
    }
}
