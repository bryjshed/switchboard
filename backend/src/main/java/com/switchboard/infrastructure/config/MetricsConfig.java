package com.switchboard.infrastructure.config;

import com.switchboard.application.stream.EnvironmentStreamHub;
import io.micrometer.core.instrument.Gauge;
import io.micrometer.core.instrument.MeterRegistry;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Binds the meters that make the caching work measurable rather than reasoned about.
 *
 * <p>Instrumentation lives here rather than in the classes it measures so that
 * {@code application/} stays free of a metrics vendor. Cache meters are bound by {@code CacheConfig}
 * alongside the registry that owns them; what is left here is the stream hub's gauges and the names
 * of the two hot-path timers, which have to be recorded inside the call they measure.
 */
@Configuration
public class MetricsConfig {

    /** Timer name for SDK-key -> environment resolution. One SQL join per evaluation request. */
    public static final String SDK_KEY_RESOLVE_TIMER = "switchboard.auth.sdk_key.resolve";
    /** Timer name for RBAC permission resolution. One union query per authorization decision. */
    public static final String PERMISSION_RESOLVE_TIMER = "switchboard.access.permissions.resolve";

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
