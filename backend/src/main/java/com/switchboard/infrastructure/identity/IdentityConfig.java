package com.switchboard.infrastructure.identity;

import com.switchboard.domain.identity.IdentityProviderPort;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Builds the provider registry from {@code switchboard.auth.providers}, and refuses to start when
 * that configuration cannot work.
 *
 * <p>Failing at startup is the point. A provider with no issuer, two providers claiming one
 * issuer, or a deployment with no way at all to authenticate a person are all mistakes that would
 * otherwise surface as an unexplained 401 during someone's first login, hours later and far from
 * the file that caused it.
 *
 * <p>Network work is deliberately <em>not</em> done here: OIDC discovery and the first JWKS fetch
 * happen on first use, so an IdP that is briefly unreachable delays a login rather than preventing
 * the service from booting.
 */
@Configuration
@EnableConfigurationProperties(AuthProperties.class)
public class IdentityConfig {

    private static final Logger log = LoggerFactory.getLogger(IdentityConfig.class);

    /**
     * Read from the OS environment rather than Spring configuration because that is where the
     * Firebase tooling puts it and where the Admin SDK looks for it.
     */
    private static String emulatorHost() {
        return System.getenv("FIREBASE_AUTH_EMULATOR_HOST");
    }

    @Bean
    public IdentityProviderRegistry identityProviderRegistry(
        AuthProperties auth,
        @Value("${switchboard.security.dev-auth-enabled:false}") boolean devAuthEnabled) {

        Map<String, IdentityProviderPort> byIssuer = new LinkedHashMap<>();
        Map<String, String> issuerOwner = new LinkedHashMap<>();
        Set<String> ids = new LinkedHashSet<>();
        List<AuthProperties.Provider> providers = auth.getProviders();

        for (int index = 0; index < providers.size(); index++) {
            AuthProperties.Provider provider = providers.get(index);
            String where = "switchboard.auth.providers[" + index + "]";
            String id = require(provider.getId(), where, "id");
            if (!ids.add(id)) {
                throw misconfigured(where, "id '" + id + "' is already used by another provider");
            }
            where = where + " (id=" + id + ")";
            if (provider.getType() == null) {
                throw misconfigured(where, "needs a type: one of oidc, firebase");
            }
            Built built = build(provider, where);
            String owner = issuerOwner.putIfAbsent(built.issuer(), id);
            if (owner != null) {
                throw misconfigured(where, "issuer '" + built.issuer()
                    + "' is already served by provider '" + owner + "'. Two providers cannot claim "
                    + "one issuer: token routing is by issuer and the choice would be arbitrary");
            }
            byIssuer.put(built.issuer(), built.provider());
            log.info("Identity provider '{}' ({}) verifying tokens from {}",
                id, provider.getType(), built.issuer());
        }

        if (byIssuer.isEmpty() && !devAuthEnabled) {
            throw new IllegalStateException(
                "No identity providers are configured under switchboard.auth.providers and dev "
                    + "tokens are disabled, so no user could authenticate. Configure at least one "
                    + "provider (type: oidc with an issuer, or type: firebase with a project-id).");
        }
        if (byIssuer.isEmpty()) {
            log.warn("No identity providers configured; only local dev tokens can authenticate");
        }

        return new IdentityProviderRegistry(
            byIssuer, devAuthEnabled ? new DevTokenIdentityProvider() : null);
    }

    private static Built build(AuthProperties.Provider provider, String where) {
        return switch (provider.getType()) {
            case FIREBASE -> {
                String projectId = require(provider.getProjectId(), where, "project-id");
                yield new Built(
                    FirebaseIdentityProvider.issuerFor(projectId),
                    new FirebaseIdentityProvider(
                        projectId, emulatorHost(), provider.getJwkCacheTtl()));
            }
            case OIDC -> {
                String issuer = require(provider.getIssuer(), where, "issuer");
                requireClaim(provider.getEmailClaim(), where, "email-claim");
                requireClaim(provider.getNameClaim(), where, "name-claim");
                requireClaim(provider.getEmailVerifiedClaim(), where, "email-verified-claim");
                if (provider.getJwkSetUri() == null || provider.getJwkSetUri().isBlank()) {
                    log.info("Provider at {} has no jwk-set-uri; OIDC discovery will be used", issuer);
                }
                yield new Built(issuer, new OidcIdentityProvider(
                    issuer,
                    provider.getJwkSetUri(),
                    provider.getAudience(),
                    provider.getEmailClaim(),
                    provider.getNameClaim(),
                    provider.getEmailVerifiedClaim(),
                    provider.getJwkCacheTtl()));
            }
        };
    }

    private static String require(String value, String where, String field) {
        if (value == null || value.isBlank()) {
            throw misconfigured(where, "needs a " + field);
        }
        return value.trim();
    }

    private static void requireClaim(String value, String where, String field) {
        if (value == null || value.isBlank()) {
            throw misconfigured(where, field + " cannot be blank; omit it to accept the default");
        }
    }

    private static IllegalStateException misconfigured(String where, String problem) {
        return new IllegalStateException(where + " " + problem);
    }

    private record Built(String issuer, IdentityProviderPort provider) {
    }
}
