package com.switchboard.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.evaluation.EnvSnapshotCache;
import com.switchboard.infrastructure.config.MetricsConfig;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.search.Search;
import java.time.Duration;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpHeaders;
import org.springframework.test.web.reactive.server.WebTestClient;

/**
 * The meters that make the caching work evidence-driven rather than reasoned about.
 *
 * <p>These assert on the registry rather than on {@code /actuator/prometheus}, because the
 * scrape endpoint lives in the management child context on its own port and what is being
 * verified here is that the instrumentation records - not that the actuator serves.
 *
 * <p>The point of each assertion is that the meter <em>moves</em>. A meter that exists and
 * always reads zero is worse than no meter: it looks like a working cache with no traffic.
 */
class MetricsIT extends IntegrationTestBase {

    @Autowired
    private MeterRegistry meters;

    /** Random in tests; application.yml pins it to 28081. */
    @Value("${local.management.port}")
    private int managementPort;

    @Test
    @DisplayName("the snapshot cache records a miss then a hit across two identical bootstraps")
    void snapshotCacheHitsAreRecorded() {
        Workspace workspace = createWorkspace("metrics-cache");
        createBooleanFlag(workspace, "metrics-cache-flag");
        String sdkKey = mintSdkKey(workspace, "production");

        // Caffeine only counts stats when recordStats() is on the builder. If that regresses,
        // every count below stays at zero and this test is what catches it.
        double before = cacheGets();
        bootstrap(sdkKey);
        double afterFirst = cacheGets();
        bootstrap(sdkKey);
        double afterSecond = cacheGets();

        assertThat(afterFirst)
            .as("the first bootstrap must be counted as a cache access")
            .isGreaterThan(before);
        assertThat(afterSecond)
            .as("the second bootstrap must be counted too - a cache that stops counting on a hit "
                + "reports a 0%% hit rate forever")
            .isGreaterThan(afterFirst);
        assertThat(Search.in(meters).name("cache.size")
            .tag("cache", EnvSnapshotCache.CACHE_NAME).gauge())
            .as("cache.size gauge must be bound")
            .isNotNull();
    }

    @Test
    @DisplayName("SDK-key resolution is timed, and now happens once rather than per request")
    void sdkKeyResolutionIsTimed() {
        Workspace workspace = createWorkspace("metrics-sdk-key");
        createBooleanFlag(workspace, "metrics-sdk-key-flag");
        String sdkKey = mintSdkKey(workspace, "production");

        Timer timer = requireTimer(MetricsConfig.SDK_KEY_RESOLVE_TIMER);
        long before = timer.count();
        bootstrap(sdkKey);
        bootstrap(sdkKey);

        // This asserted 2 when it was written, and that was correct then: nothing cached the
        // sdk_keys -> environments -> projects join, so it ran once per evaluation request. It is
        // 1 now because the cache landed, and this measurement is what argued for it. Left as an
        // equality rather than a bound, so a regression that quietly reverts the cache fails here
        // rather than passing a "<= 2".
        assertThat(timer.count() - before)
            .as("the key resolves against the database once, then from cache")
            .isEqualTo(1);
    }

    @Test
    @DisplayName("permission resolution is timed on every authorization decision")
    void permissionResolutionIsTimed() {
        Workspace workspace = createWorkspace("metrics-permissions");

        Timer timer = requireTimer(MetricsConfig.PERMISSION_RESOLVE_TIMER);
        long before = timer.count();
        createBooleanFlag(workspace, "metrics-permission-flag");

        assertThat(timer.count())
            .as("a management write resolves permissions at least once")
            .isGreaterThan(before);
    }

    @Test
    @DisplayName("the scrape endpoint is served, unauthenticated, on the management port only")
    void prometheusIsScrapeableOnTheManagementPort() {
        Workspace workspace = createWorkspace("metrics-scrape");
        createBooleanFlag(workspace, "metrics-scrape-flag");
        bootstrap(mintSdkKey(workspace, "production"));

        WebTestClient management = WebTestClient.bindToServer()
            .baseUrl("http://localhost:" + managementPort)
            .responseTimeout(Duration.ofSeconds(30))
            .build();

        // No Authorization header: a scraper does not have a bearer token. The filter chain does
        // apply to this listener, so without an explicit permitAll this 401s and the endpoint is
        // silently useless - which is exactly what happened the first time.
        String body = management.get().uri("/actuator/prometheus")
            .exchange()
            .expectStatus().isOk()
            .expectBody(String.class)
            .returnResult().getResponseBody();

        assertThat(body).contains("cache_gets_total");
        assertThat(body).contains(EnvSnapshotCache.CACHE_NAME);
        assertThat(body).contains("switchboard_auth_sdk_key_resolve");

        // The main listener must not serve it. The path is unmapped there once actuator moves to
        // the management port, so permitAll on the path cannot expose it.
        http.get().uri("/actuator/prometheus").exchange().expectStatus().isNotFound();
    }

    @Test
    @DisplayName("the SSE subscriber and environment gauges are bound")
    void streamGaugesAreBound() {
        assertThat(Search.in(meters).name("switchboard.stream.subscribers").gauge())
            .isNotNull();
        // Bound alongside the subscriber count on purpose: sinks are never removed from the hub,
        // so a widening gap between the two is the sink leak becoming visible.
        assertThat(Search.in(meters).name("switchboard.stream.environments").gauge())
            .isNotNull();
    }

    private void bootstrap(String sdkKey) {
        http.get().uri("/api/eval/bootstrap")
            .header(HttpHeaders.AUTHORIZATION, "Bearer " + sdkKey)
            .exchange()
            .expectStatus().isOk();
    }

    /** Total cache accesses across every {@code result} tag, hits and misses alike. */
    private double cacheGets() {
        return Search.in(meters).name("cache.gets")
            .tag("cache", EnvSnapshotCache.CACHE_NAME)
            .functionCounters().stream()
            .mapToDouble(counter -> counter.count())
            .sum()
            + Search.in(meters).name("cache.gets")
            .tag("cache", EnvSnapshotCache.CACHE_NAME)
            .counters().stream()
            .mapToDouble(counter -> counter.count())
            .sum();
    }

    private Timer requireTimer(String name) {
        Timer timer = Search.in(meters).name(name).timer();
        assertThat(timer).as("timer %s must be registered", name).isNotNull();
        return timer;
    }
}
