package com.switchboard.infrastructure.identity;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.context.support.PropertySourcesPlaceholderConfigurer;

/**
 * Misconfiguration must fail at startup, not at someone's first login.
 *
 * <p>Every case here would otherwise be an unexplained 401 hours later, with nothing in the logs
 * pointing at the config file that caused it.
 */
class IdentityConfigTest {

    private static final IdentityConfig CONFIG = new IdentityConfig();

    private static AuthProperties.Provider provider(String id, AuthProperties.Type type) {
        AuthProperties.Provider provider = new AuthProperties.Provider();
        provider.setId(id);
        provider.setType(type);
        return provider;
    }

    private static AuthProperties.Provider oidc(String id, String issuer) {
        AuthProperties.Provider provider = provider(id, AuthProperties.Type.OIDC);
        provider.setIssuer(issuer);
        return provider;
    }

    private static AuthProperties.Provider firebase(String id, String projectId) {
        AuthProperties.Provider provider = provider(id, AuthProperties.Type.FIREBASE);
        provider.setProjectId(projectId);
        return provider;
    }

    private static IdentityProviderRegistry build(
        boolean devAuth, AuthProperties.Provider... providers) {
        AuthProperties auth = new AuthProperties();
        auth.setProviders(List.of(providers));
        return CONFIG.identityProviderRegistry(auth, devAuth);
    }

    @Test
    void acceptsSeveralProvidersAtOnce() {
        IdentityProviderRegistry registry = build(false,
            firebase("firebase-local", "demo-switchboard"),
            oidc("corp-okta", "https://example.okta.com/oauth2/default"));

        assertThat(registry.issuers()).containsExactlyInAnyOrder(
            "https://securetoken.google.com/demo-switchboard",
            "https://example.okta.com/oauth2/default");
        assertThat(registry.devAuthEnabled()).isFalse();
    }

    @Test
    void refusesAProviderWithNoId() {
        assertThatThrownBy(() -> build(true, oidc(null, "https://issuer.example")))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("switchboard.auth.providers[0]")
            .hasMessageContaining("needs a id");
    }

    @Test
    void refusesTwoProvidersSharingAnId() {
        assertThatThrownBy(() -> build(true,
            oidc("same", "https://a.example"), oidc("same", "https://b.example")))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("id 'same' is already used");
    }

    @Test
    void refusesTwoProvidersSharingAnIssuer() {
        assertThatThrownBy(() -> build(true,
            oidc("first", "https://a.example"), oidc("second", "https://a.example")))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("already served by provider 'first'");
    }

    @Test
    void refusesAProviderWithNoType() {
        assertThatThrownBy(() -> build(true, provider("typeless", null)))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("needs a type: one of oidc, firebase");
    }

    @Test
    void refusesAnOidcProviderWithNoIssuer() {
        assertThatThrownBy(() -> build(true, oidc("no-issuer", null)))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("(id=no-issuer) needs a issuer");
    }

    @Test
    void refusesAFirebaseProviderWithNoProjectId() {
        assertThatThrownBy(() -> build(true, firebase("no-project", " ")))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("(id=no-project) needs a project-id");
    }

    @Test
    void refusesABlankClaimName() {
        AuthProperties.Provider provider = oidc("blank-claim", "https://issuer.example");
        provider.setEmailClaim("");

        assertThatThrownBy(() -> build(true, provider))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("email-claim cannot be blank");
    }

    @Test
    void refusesADeploymentNobodyCouldAuthenticateAgainst() {
        assertThatThrownBy(() -> build(false))
            .isInstanceOf(IllegalStateException.class)
            .hasMessageContaining("no user could authenticate");
    }

    /** The same refusal, reached the way a deployment would reach it: context startup. */
    @Test
    void aMisconfiguredProviderStopsTheApplicationFromStarting() {
        contextRunner()
            .withPropertyValues(
                "switchboard.security.dev-auth-enabled=true",
                "switchboard.auth.providers[0].id=corp-okta",
                "switchboard.auth.providers[0].type=oidc")
            .run(context -> assertThat(context)
                .hasFailed()
                .getFailure()
                .hasMessageContaining("switchboard.auth.providers[0] (id=corp-okta) needs a issuer"));
    }

    @Test
    void bindsProvidersFromConfigurationTheWayADeploymentWould() {
        contextRunner()
            .withPropertyValues(
                "switchboard.security.dev-auth-enabled=false",
                "switchboard.auth.providers[0].id=firebase-local",
                "switchboard.auth.providers[0].type=firebase",
                "switchboard.auth.providers[0].project-id=demo-switchboard",
                "switchboard.auth.providers[1].id=corp-okta",
                "switchboard.auth.providers[1].type=oidc",
                "switchboard.auth.providers[1].issuer=https://example.okta.com/oauth2/default",
                "switchboard.auth.providers[1].audience=switchboard",
                "switchboard.auth.providers[1].name-claim=preferred_username")
            .run(context -> assertThat(context.getBean(IdentityProviderRegistry.class).issuers())
                .containsExactlyInAnyOrder(
                    "https://securetoken.google.com/demo-switchboard",
                    "https://example.okta.com/oauth2/default"));
    }

    @Test
    void allowsAProviderlessLocalDeploymentWhereDevTokensWork() {
        IdentityProviderRegistry registry = build(true);

        assertThat(registry.issuers()).isEmpty();
        assertThat(registry.devAuthEnabled()).isTrue();
    }

    private static ApplicationContextRunner contextRunner() {
        return new ApplicationContextRunner()
            .withUserConfiguration(IdentityConfig.class, Placeholders.class);
    }

    /** {@code @Value} needs one of these; a full application context brings its own. */
    @Configuration
    static class Placeholders {

        @Bean
        static PropertySourcesPlaceholderConfigurer placeholderConfigurer() {
            return new PropertySourcesPlaceholderConfigurer();
        }
    }
}
