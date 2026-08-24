package com.switchboard.interfaces.security;

import com.google.firebase.auth.FirebaseAuth;
import com.google.firebase.auth.FirebaseToken;
import com.switchboard.application.user.UserService;
import io.r2dbc.spi.Readable;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.ReactiveAuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

/**
 * Routes bearer tokens to one of three principal types:
 * dev:&lt;email&gt; (local profile only), sb_srv_* SDK keys, or Firebase ID tokens.
 */
@Component
public class SwitchboardAuthenticationManager implements ReactiveAuthenticationManager {

    static final String SDK_KEY_PREFIX = "sb_srv_";
    private static final String DEV_PREFIX = "dev:";
    private static final List<SimpleGrantedAuthority> USER_AUTHORITIES =
        List.of(new SimpleGrantedAuthority("ROLE_USER"));
    private static final List<SimpleGrantedAuthority> SDK_AUTHORITIES =
        List.of(new SimpleGrantedAuthority("ROLE_SDK"));

    private final UserService userService;
    private final DatabaseClient db;
    private final ObjectProvider<FirebaseAuth> firebaseAuth;
    private final boolean devAuthEnabled;

    public SwitchboardAuthenticationManager(
        UserService userService,
        DatabaseClient db,
        ObjectProvider<FirebaseAuth> firebaseAuth,
        @Value("${switchboard.security.dev-auth-enabled:false}") boolean devAuthEnabled) {
        this.userService = userService;
        this.db = db;
        this.firebaseAuth = firebaseAuth;
        this.devAuthEnabled = devAuthEnabled;
    }

    @Override
    public Mono<Authentication> authenticate(Authentication authentication) {
        if (!(authentication instanceof BearerTokenAuthenticationToken bearer)) {
            return Mono.empty();
        }
        String token = bearer.token();
        if (token.startsWith(SDK_KEY_PREFIX)) {
            return authenticateSdkKey(token);
        }
        if (token.startsWith(DEV_PREFIX)) {
            if (!devAuthEnabled) {
                return Mono.error(new BadCredentialsException("Dev tokens are disabled"));
            }
            String email = token.substring(DEV_PREFIX.length());
            if (email.isBlank()) {
                return Mono.error(new BadCredentialsException("Empty dev token email"));
            }
            return userService.resolveDevUser(email).map(this::userAuth);
        }
        return authenticateFirebase(token);
    }

    private Mono<Authentication> authenticateFirebase(String token) {
        FirebaseAuth auth = firebaseAuth.getIfAvailable();
        if (auth == null) {
            return Mono.error(new BadCredentialsException("Firebase auth is not configured"));
        }
        return Mono.fromCallable(() -> auth.verifyIdToken(token))
            .subscribeOn(Schedulers.boundedElastic())
            .onErrorMap(e -> new BadCredentialsException("Invalid Firebase token", e))
            .flatMap(this::resolveFirebaseUser);
    }

    private Mono<Authentication> resolveFirebaseUser(FirebaseToken decoded) {
        String email = decoded.getEmail();
        if (email == null || email.isBlank()) {
            return Mono.error(new BadCredentialsException("Firebase token carries no email"));
        }
        return userService.resolveFirebaseUser(decoded.getUid(), email, decoded.getName())
            .map(this::userAuth);
    }

    private Authentication userAuth(com.switchboard.domain.user.User user) {
        AuthenticatedUser principal = new AuthenticatedUser(user.id(), user.email());
        return UsernamePasswordAuthenticationToken.authenticated(principal, null, USER_AUTHORITIES);
    }

    private Mono<Authentication> authenticateSdkKey(String token) {
        return db.sql("""
                SELECT k.id AS key_id, k.environment_id, e.project_id, p.org_id, e.key AS env_key
                FROM sdk_keys k
                JOIN environments e ON e.id = k.environment_id
                JOIN projects p ON p.id = e.project_id
                WHERE k.key_hash = :hash AND k.revoked_at IS NULL
                """)
            .bind("hash", sha256(token))
            .map(SwitchboardAuthenticationManager::mapSdkKey)
            .one()
            .switchIfEmpty(Mono.error(new BadCredentialsException("Unknown or revoked SDK key")))
            .map(p -> UsernamePasswordAuthenticationToken.authenticated(p, null, SDK_AUTHORITIES));
    }

    private static SdkKeyPrincipal mapSdkKey(Readable row) {
        return new SdkKeyPrincipal(
            row.get("key_id", UUID.class),
            row.get("environment_id", UUID.class),
            row.get("project_id", UUID.class),
            row.get("org_id", UUID.class),
            row.get("env_key", String.class));
    }

    public static String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(digest.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
