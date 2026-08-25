package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.infrastructure.config.MetricsConfig;
import com.switchboard.interfaces.rest.model.RoleAssignmentResponse;
import com.switchboard.interfaces.rest.model.ScopeType;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.search.Search;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;

/**
 * The permissions cache, and the one risk it introduces.
 *
 * <p>Caching an authorization decision is the most dangerous cache in the system, because the
 * failure mode is not "slow" but "someone keeps access that was just taken away". So the TTL is the
 * shortest of any cache here, and revocation evicts rather than waiting it out - which is what
 * {@link #revocationTakesEffectImmediately()} exists to hold in place.
 */
class PermissionCacheIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";

    @Autowired
    private MeterRegistry meters;

    @Test
    @DisplayName("repeated authorized requests resolve permissions from cache")
    void permissionsResolveOnce() {
        Workspace workspace = createWorkspace("permcache");

        Timer resolve = timer();
        long before = resolve.count();

        // Five reads by the same caller at the same scope.
        for (int i = 0; i < 5; i++) {
            http.get().uri("/api/projects/{projectId}/flags", workspace.projectId())
                .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
                .exchange()
                .expectStatus().isOk();
        }

        long resolutions = resolve.count() - before;
        assertThat(resolutions)
            .as("five identical authorization questions must not be five union queries")
            .isLessThan(5);
    }

    @Test
    @DisplayName("a revoked role stops working at once, not when the TTL expires")
    void revocationTakesEffectImmediately() {
        Workspace workspace = createWorkspace("revoke-perm");
        String reviewer = uniqueEmail("reviewer");

        RoleAssignmentResponse assignment = grantRole(
            workspace, reviewer, ScopeType.ENVIRONMENT, workspace.environmentId(ENV_KEY), "APPROVER");

        // Exercise it, so the grant is definitely cached before it is taken away.
        http.get().uri("/api/environments/{envId}/approval-settings", workspace.environmentId(ENV_KEY))
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(reviewer))
            .exchange()
            .expectStatus().isOk();

        http.delete()
            .uri("/api/orgs/{orgId}/role-assignments/{id}", workspace.orgId(), assignment.getId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isNoContent();

        // No sleep, no TTL wait. If this passes only after 30 seconds, revocation is a suggestion.
        http.get().uri("/api/environments/{envId}/approval-settings", workspace.environmentId(ENV_KEY))
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(reviewer))
            .exchange()
            .expectStatus().isForbidden();
    }

    @Test
    @DisplayName("a newly granted role works at once")
    void grantTakesEffectImmediately() {
        Workspace workspace = createWorkspace("grant-perm");
        String newcomer = uniqueEmail("newcomer");

        // Ask first, and be refused. This is what would poison a cache that remembered absence.
        provisionUser(newcomer);
        http.get().uri("/api/environments/{envId}/approval-settings", workspace.environmentId(ENV_KEY))
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(newcomer))
            .exchange()
            .expectStatus().isForbidden();

        grantRole(workspace, newcomer, ScopeType.ENVIRONMENT,
            workspace.environmentId(ENV_KEY), "APPROVER");

        // "No standing" must never be a cached answer: it changes the instant someone is granted a
        // role, which is exactly when the person retries.
        http.get().uri("/api/environments/{envId}/approval-settings", workspace.environmentId(ENV_KEY))
            .header(HttpHeaders.AUTHORIZATION, bearerDevToken(newcomer))
            .exchange()
            .expectStatus().isOk();
    }

    private Timer timer() {
        Timer timer = Search.in(meters).name(MetricsConfig.PERMISSION_RESOLVE_TIMER).timer();
        assertThat(timer).isNotNull();
        return timer;
    }
}
