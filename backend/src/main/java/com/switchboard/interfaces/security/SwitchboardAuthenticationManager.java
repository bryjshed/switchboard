package com.switchboard.interfaces.security;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.application.cache.SwitchboardCache;
import com.switchboard.application.user.UserService;
import com.switchboard.domain.identity.IdentityProviderPort;
import com.switchboard.domain.identity.IdentityVerificationException;
import com.switchboard.domain.identity.VerifiedIdentity;
import com.switchboard.domain.project.SdkKeyKind;
import com.switchboard.domain.user.User;
import com.switchboard.infrastructure.config.MetricsConfig;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.r2dbc.spi.Readable;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.TimeUnit;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.security.authentication.BadCredentialsException;
import org.springframework.security.authentication.ReactiveAuthenticationManager;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * Routes bearer tokens to one of three principal types.
 *
 * <p>An SDK key is not an identity - it names an environment, not a person - so it is resolved
 * here against the {@code sdk_keys} table and never reaches the identity layer. Everything else is
 * a user token, and which provider verifies it is the registry's problem rather than this class's:
 * dev token, Firebase, Okta, Auth0, Entra ID and Keycloak all arrive at the same
 * {@link VerifiedIdentity} and the same {@link AuthenticatedUser}.
 */
@Component
public class SwitchboardAuthenticationManager implements ReactiveAuthenticationManager {

    /**
     * Every SDK key kind starts with this. Deliberately a WIDENING of the old {@code "sb_srv_"}
     * test rather than a prefix-to-kind map: it is a strict widening (no OIDC JWT starts
     * {@code eyJ}, no dev token starts {@code dev:}, and neither begins {@code sb_}), it makes
     * adding a kind a data-only change, and it keeps the prefix from carrying any authority.
     * The kind itself is read from the row - see {@link #authenticateSdkKey}.
     */
    static final String SDK_KEY_PREFIX = SdkKeyKind.COMMON_PREFIX;
    private static final List<SimpleGrantedAuthority> USER_AUTHORITIES =
        List.of(new SimpleGrantedAuthority("ROLE_USER"));
    private static final List<SimpleGrantedAuthority> SDK_AUTHORITIES =
        List.of(new SimpleGrantedAuthority("ROLE_SDK"));

    private final UserService userService;
    private final DatabaseClient db;
    private final IdentityProviderPort identities;
    private final SwitchboardCache<String, SdkKeyPrincipal> sdkKeys;
    private final Timer sdkKeyResolve;

    public SwitchboardAuthenticationManager(
        UserService userService, DatabaseClient db, IdentityProviderPort identities,
        CacheRegistry caches, MeterRegistry meters) {
        this.userService = userService;
        this.db = db;
        this.identities = identities;
        this.sdkKeys = caches.cache(CacheName.SDK_KEY);
        this.sdkKeyResolve = Timer.builder(MetricsConfig.SDK_KEY_RESOLVE_TIMER)
            .description("Resolving an SDK key to its environment: sdk_keys -> environments -> projects")
            .register(meters);
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
        return authenticateUser(token);
    }

    private Mono<Authentication> authenticateUser(String token) {
        return identities.verify(token)
            .onErrorMap(IdentityVerificationException.class,
                e -> new BadCredentialsException(e.getMessage(), e))
            .flatMap(identity -> userService.resolveIdentity(identity)
                .map(user -> userAuth(user, identity)));
    }

    private Authentication userAuth(User user, VerifiedIdentity identity) {
        AuthenticatedUser principal = new AuthenticatedUser(
            user.id(), user.email(), identity.issuer(), identity.subject());
        return UsernamePasswordAuthenticationToken.authenticated(principal, null, USER_AUTHORITIES);
    }

    /**
     * Resolves an SDK key to its environment, through the cache.
     *
     * <p>This ran a three-table join on <b>every</b> evaluation request - the single hottest path in
     * the product - to answer a question whose answer changes only when a key is minted or revoked.
     * Both of those evict, locally and across instances, so the cache is not merely TTL-bounded.
     *
     * <p><b>The key is the hash, never the token.</b> The token is a live credential; the hash is
     * what the database already stores and what a heap dump may safely contain.
     *
     * <p>Absence is cached too, briefly. An unknown key used to reach the database on every attempt,
     * so spraying invented keys was an unbounded-load denial-of-service vector rather than just
     * waste. The timer stays: it is now the evidence that the cache is working, and it is the
     * before/after that justified writing it.
     */
    private Mono<Authentication> authenticateSdkKey(String token) {
        String hash = sha256(token);
        return sdkKeys.get(hash, this::loadSdkKey)
            .switchIfEmpty(Mono.error(new BadCredentialsException("Unknown or revoked SDK key")))
            .map(p -> UsernamePasswordAuthenticationToken.authenticated(p, null, SDK_AUTHORITIES));
    }

    private Mono<SdkKeyPrincipal> loadSdkKey(String hash) {
        return Mono.defer(() -> {
            long startedAt = System.nanoTime();
            return db.sql("""
                    SELECT k.id AS key_id, k.kind, k.environment_id, e.project_id, p.org_id,
                           e.key AS env_key
                    FROM sdk_keys k
                    JOIN environments e ON e.id = k.environment_id
                    JOIN projects p ON p.id = e.project_id
                    WHERE k.key_hash = :hash AND k.revoked_at IS NULL
                    """)
                .bind("hash", hash)
                .map(SwitchboardAuthenticationManager::mapSdkKey)
                .one()
                .doFinally(signal -> sdkKeyResolve.record(
                    System.nanoTime() - startedAt, TimeUnit.NANOSECONDS));
        });
    }

    private static SdkKeyPrincipal mapSdkKey(Readable row) {
        return new SdkKeyPrincipal(
            row.get("key_id", UUID.class),
            SdkKeyKind.valueOf(row.get("kind", String.class)),
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
