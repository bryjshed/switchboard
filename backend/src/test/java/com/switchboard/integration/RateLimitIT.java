package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.http.HttpHeaders;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.test.web.reactive.server.EntityExchangeResult;

/**
 * The rate limiter, and the 429 that OFREP has always documented but nothing could produce.
 *
 * <p>Limits here are set absurdly low by property so the behaviour is testable in a handful of
 * requests. The production defaults are generous - a page load fans out into several requests, and
 * an SDK fleet reconnecting after a deploy is a legitimate burst.
 */
class RateLimitIT extends IntegrationTestBase {

    /**
     * Tight limits, added rather than substituted.
     *
     * <p>Re-declaring {@code @SpringBootTest} on a subclass REPLACES the base annotation instead of
     * merging with it, which silently drops both {@code webEnvironment} and every property the base
     * sets - including dev auth, so every request 401s. A dynamic property source adds to what the
     * base already registered, which is what was wanted.
     */
    @DynamicPropertySource
    static void tightLimits(DynamicPropertyRegistry registry) {
        registry.add("switchboard.ratelimit.enabled", () -> "true");
        registry.add("switchboard.ratelimit.requests-per-minute", () -> "60");
        // 20 rather than something tiny: creating a workspace is itself several API calls, so a
        // burst small enough to trip in three requests trips during setup instead of during the
        // thing being tested.
        registry.add("switchboard.ratelimit.burst", () -> "20");
    }

    @Test
    @DisplayName("a client over its burst gets 429 with a usable Retry-After")
    void burstIsEnforced() {
        Workspace workspace = createWorkspace("ratelimit");
        String auth = workspace.authorization();

        // Burst is 20 and refill is one token per second, far slower than this loop, so a run of
        // 40 must be refused partway through.
        int refused = 0;
        String retryAfter = null;
        for (int i = 0; i < 40; i++) {
            EntityExchangeResult<byte[]> result = http.get().uri("/api/users/me")
                .header(HttpHeaders.AUTHORIZATION, auth)
                .exchange()
                .expectBody().returnResult();
            if (result.getStatus().value() == 429) {
                refused++;
                retryAfter = result.getResponseHeaders().getFirst(HttpHeaders.RETRY_AFTER);
            }
        }

        assertThat(refused).as("a burst beyond the allowance is refused").isPositive();
        assertThat(retryAfter)
            .as("OFREP documents this header; a 429 without it tells a client nothing")
            .isNotNull();
        // Zero would invite an immediate retry, which is the opposite of what a 429 is asking for.
        assertThat(Long.parseLong(retryAfter)).isPositive();
    }

    @Test
    @DisplayName("one client's burst does not throttle another")
    void bucketsArePerCredential() {
        Workspace noisy = createWorkspace("ratelimit-noisy");
        Workspace quiet = createWorkspace("ratelimit-quiet");

        for (int i = 0; i < 40; i++) {
            http.get().uri("/api/users/me")
                .header(HttpHeaders.AUTHORIZATION, noisy.authorization())
                .exchange();
        }

        // A shared bucket would make one bad client an outage for everybody else.
        http.get().uri("/api/users/me")
            .header(HttpHeaders.AUTHORIZATION, quiet.authorization())
            .exchange()
            .expectStatus().isOk();
    }

    @Test
    @DisplayName("health is never throttled")
    void actuatorIsExempt() {
        Workspace workspace = createWorkspace("ratelimit-health");
        for (int i = 0; i < 40; i++) {
            http.get().uri("/api/users/me")
                .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
                .exchange();
        }

        // A limiter that can make a pod look unhealthy under load turns a traffic spike into a
        // restart loop. Actuator lives on the management port, but the path is exempt either way.
        http.get().uri("/actuator/health").exchange().expectStatus().isNotFound();
    }
}
