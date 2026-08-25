package com.switchboard.infrastructure.config;

import com.switchboard.application.evaluation.EnvSnapshotCache;
import com.switchboard.application.stream.EnvironmentStreamHub;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tags;
import io.micrometer.core.instrument.binder.MeterBinder;
import io.micrometer.core.instrument.binder.cache.CaffeineCacheMetrics;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Binds the meters that make the caching work measurable rather than reasoned about.
 *
 * <p>Instrumentation lives here rather than in the classes it measures so that
 * {@code application/} stays free of a metrics vendor. The classes expose plain accessors
 * ({@link EnvSnapshotCache#statsView()}, {@link EnvironmentStreamHub#subscriberCount()}) and this
 * config is the only place that knows Micrometer exists - except for the two hot-path timers, whose
 * names are declared here but which have to be recorded inside the call they measure.
 */
@Configuration
public class MetricsConfig {

    /** Timer name for SDK-key -> environment resolution. One SQL join per evaluation request. */
    public static final String SDK_KEY_RESOLVE_TIMER = "switchboard.auth.sdk_key.resolve";
    /** Timer name for RBAC permission resolution. One union query per authorization decision. */
    public static final String PERMISSION_RESOLVE_TIMER = "switchboard.access.permissions.resolve";

    /**
     * Hit rate, eviction count, load latency and size for the environment snapshot cache.
     * Requires {@code recordStats()} on the Caffeine builder; without it every meter reads zero
     * and the cache looks broken while working perfectly.
     */
    @Bean
    public MeterBinder envSnapshotCacheMetrics(EnvSnapshotCache cache) {
        // Returned as a MeterBinder rather than bound here: Boot binds every MeterBinder bean to
        // every registry it builds, which is one fewer thing to get wrong than binding by hand.
        // Note CaffeineCacheMetrics.monitor() returns the *cache*, not the binder.
        return new CaffeineCacheMetrics<>(cache.statsView(), EnvSnapshotCache.CACHE_NAME, Tags.empty());
    }

    @Bean
    public Gauge sseSubscriberGauge(MeterRegistry registry, EnvironmentStreamHub hub) {
        return Gauge.builder("switchboard.stream.subscribers", hub, EnvironmentStreamHub::subscriberCount)
            .description("Live SSE subscribers across every environment")
            .register(registry);
    }

    @Bean
    public Gauge sseTrackedEnvironmentGauge(MeterRegistry registry, EnvironmentStreamHub hub) {
        return Gauge.builder("switchboard.stream.environments", hub,
                EnvironmentStreamHub::trackedEnvironmentCount)
            .description("Environments holding a stream sink; never decreases, so a growing gap "
                + "against switchboard.stream.subscribers is the sink leak")
            .register(registry);
    }

}
