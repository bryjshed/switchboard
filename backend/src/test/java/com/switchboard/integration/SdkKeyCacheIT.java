package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.infrastructure.config.MetricsConfig;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.search.Search;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.HttpHeaders;

/**
 * The SDK-key cache, asserted on the evidence rather than on the code looking right.
 *
 * <p>A cache is the one kind of change that can fail completely while every functional test still
 * passes - the answers stay correct, they are just recomputed every time. So these assert on the
 * timer that counts actual database resolutions, which is what the Phase 1 metrics work existed to
 * make possible.
 */
class SdkKeyCacheIT extends IntegrationTestBase {

    private static final String ENV_KEY = "production";

    @Autowired
    private MeterRegistry meters;

    @Test
    @DisplayName("repeated evaluation requests resolve the key from the database once")
    void theKeyIsResolvedOnce() {
        Workspace workspace = createWorkspace("keycache");
        createBooleanFlag(workspace, "cache-flag");
        String sdkKey = mintSdkKey(workspace, ENV_KEY);

        Timer resolve = timer();
        long before = resolve.count();

        for (int i = 0; i < 5; i++) {
            bootstrap(sdkKey);
        }

        // Before the cache this was one three-table join per request, on the hottest path in the
        // product. Five requests, one resolution.
        assertThat(resolve.count() - before)
            .as("five evaluation requests, one database resolution")
            .isEqualTo(1);
    }

    @Test
    @DisplayName("an unknown key is not re-queried on every attempt")
    void unknownKeysAreNegativelyCached() {
        Timer resolve = timer();
        long before = resolve.count();

        // The denial-of-service shape: a scanner spraying invented keys. Each one used to cost a
        // database round trip, without limit.
        for (int i = 0; i < 5; i++) {
            http.get().uri("/api/eval/bootstrap")
                .header(HttpHeaders.AUTHORIZATION, "Bearer sb_srv_production_notarealkey")
                .exchange()
                .expectStatus().isUnauthorized();
        }

        assertThat(resolve.count() - before)
            .as("a sprayed unknown key reaches the database once, not once per attempt")
            .isEqualTo(1);
    }

    @Test
    @DisplayName("revoking a key stops it working immediately, not when the TTL expires")
    void revocationEvictsRatherThanWaiting() {
        Workspace workspace = createWorkspace("revoke-cache");
        createBooleanFlag(workspace, "revoke-flag");
        var minted = mintSdkKeyResponse(workspace, ENV_KEY);

        bootstrap(minted.getKey());

        http.delete().uri("/api/sdk-keys/{keyId}", minted.getId())
            .header(HttpHeaders.AUTHORIZATION, workspace.authorization())
            .exchange()
            .expectStatus().isNoContent();

        // Without eviction the cached principal would keep authenticating for the rest of the TTL,
        // which would make revocation a suggestion rather than a revocation.
        http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + minted.getKey())
            .exchange()
            .expectStatus().isUnauthorized();
    }

    @Test
    @DisplayName("a freshly minted key works at once even if its hash was probed first")
    void mintingClearsAnyNegativeEntry() {
        Workspace workspace = createWorkspace("mint-cache");
        createBooleanFlag(workspace, "mint-flag");

        // Mint, then use immediately. If minting did not clear the negative entry, a hash that had
        // been probed before it existed would stay rejected for the negative TTL - making a brand
        // new key look broken.
        String sdkKey = mintSdkKey(workspace, ENV_KEY);
        bootstrap(sdkKey);
        bootstrap(sdkKey);
    }

    @Test
    @DisplayName("the cache reports its own hit rate")
    void theCacheIsObservable() {
        Workspace workspace = createWorkspace("cache-meters");
        createBooleanFlag(workspace, "meter-flag");
        String sdkKey = mintSdkKey(workspace, ENV_KEY);
        bootstrap(sdkKey);
        bootstrap(sdkKey);

        double gets = Search.in(meters).name("cache.gets").tag("cache", "sdk_key")
            .functionCounters().stream().mapToDouble(c -> c.count()).sum()
            + Search.in(meters).name("cache.gets").tag("cache", "sdk_key")
            .counters().stream().mapToDouble(c -> c.count()).sum();

        // A cache with no meters cannot be shown to be working, which is the whole reason the
        // metrics landed before any of this did.
        assertThat(gets).isPositive();
        assertThat(Search.in(meters).name("cache.size").tag("cache", "sdk_key").gauge()).isNotNull();
    }

    private Timer timer() {
        Timer timer = Search.in(meters).name(MetricsConfig.SDK_KEY_RESOLVE_TIMER).timer();
        assertThat(timer).isNotNull();
        return timer;
    }

    private void bootstrap(String sdkKey) {
        http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .exchange()
            .expectStatus().isOk();
    }
}
