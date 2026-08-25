package com.switchboard.infrastructure.identity;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * {@code switchboard.auth} - the identity providers this deployment accepts tokens from.
 *
 * <p>The list is a list because more than one may be active at once, which is what an org
 * mid-migration between IdPs needs: old tokens and new tokens both verify, and
 * {@code UserService} links the new identity onto the existing user.
 */
@ConfigurationProperties("switchboard.auth")
public class AuthProperties {

    private List<Provider> providers = new ArrayList<>();

    public List<Provider> getProviders() {
        return providers;
    }

    public void setProviders(List<Provider> providers) {
        this.providers = providers == null ? new ArrayList<>() : providers;
    }

    /** What kind of adapter verifies this provider's tokens. */
    public enum Type {
        /** Any OIDC issuer: Auth0, Okta, Entra ID, Keycloak, Cognito, Google, Firebase in prod. */
        OIDC,
        /** Firebase, which is OIDC in production and an unsigned-token emulator locally. */
        FIREBASE
    }

    public static class Provider {

        private String id;
        private Type type;
        private String issuer;
        private String jwkSetUri;
        private String audience;
        private String projectId;
        private String emailClaim = "email";
        private String nameClaim = "name";
        private String emailVerifiedClaim = "email_verified";
        private Duration jwkCacheTtl = Duration.ofMinutes(15);

        public String getId() {
            return id;
        }

        public void setId(String id) {
            this.id = id;
        }

        public Type getType() {
            return type;
        }

        public void setType(Type type) {
            this.type = type;
        }

        public String getIssuer() {
            return issuer;
        }

        public void setIssuer(String issuer) {
            this.issuer = issuer;
        }

        /** Optional: skips OIDC discovery when the issuer does not serve a discovery document. */
        public String getJwkSetUri() {
            return jwkSetUri;
        }

        public void setJwkSetUri(String jwkSetUri) {
            this.jwkSetUri = jwkSetUri;
        }

        /** Optional: when set, the token's {@code aud} must contain it. */
        public String getAudience() {
            return audience;
        }

        public void setAudience(String audience) {
            this.audience = audience;
        }

        /** Firebase only: the project id, which fixes both the issuer and the audience. */
        public String getProjectId() {
            return projectId;
        }

        public void setProjectId(String projectId) {
            this.projectId = projectId;
        }

        public String getEmailClaim() {
            return emailClaim;
        }

        public void setEmailClaim(String emailClaim) {
            this.emailClaim = emailClaim;
        }

        public String getNameClaim() {
            return nameClaim;
        }

        public void setNameClaim(String nameClaim) {
            this.nameClaim = nameClaim;
        }

        public String getEmailVerifiedClaim() {
            return emailVerifiedClaim;
        }

        public void setEmailVerifiedClaim(String emailVerifiedClaim) {
            this.emailVerifiedClaim = emailVerifiedClaim;
        }

        /** How long a fetched JWK set may be reused before it is fetched again. */
        public Duration getJwkCacheTtl() {
            return jwkCacheTtl;
        }

        public void setJwkCacheTtl(Duration jwkCacheTtl) {
            this.jwkCacheTtl = jwkCacheTtl;
        }
    }
}
