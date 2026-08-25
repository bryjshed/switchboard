package com.switchboard.infrastructure.cache;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import io.micrometer.core.instrument.MeterRegistry;
import io.micrometer.core.instrument.Tags;
import io.micrometer.core.instrument.binder.MeterBinder;
import io.micrometer.core.instrument.binder.cache.CaffeineCacheMetrics;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Chooses the cache provider.
 *
 * <p>{@code switchboard.cache.provider} is the whole seam: services take a {@link CacheRegistry} and
 * never learn which implementation they got. Today {@code caffeine} is the only one, and that is a
 * deliberate position rather than an unfinished one - Caffeine is correct for a single instance,
 * and {@code NOTIFY} already invalidates every instance, so correctness does not require a shared
 * store. Redis earns its place when cold starts across many instances start to hurt, or when
 * something genuinely needs shared state such as multi-instance rate limiting.
 *
 * <p>An unknown provider fails at startup with a message naming what was asked for. Falling back to
 * Caffeine silently would mean a deployment that believes it has a shared cache and does not, which
 * is a worse outcome than not booting.
 */
@Configuration
public class CacheConfig {

    @Bean
    public CaffeineCacheRegistry cacheRegistry(
        @Value("${switchboard.cache.provider:caffeine}") String provider,
        @Value("${switchboard.cache.record-stats:true}") boolean recordStats) {

        if (!"caffeine".equalsIgnoreCase(provider)) {
            throw new IllegalStateException(
                "switchboard.cache.provider=" + provider + " is not implemented. Only 'caffeine' "
                    + "exists today; the seam is here so adding one is a configuration change, but "
                    + "booting with a provider that silently is not the one you asked for would be "
                    + "worse than not booting.");
        }
        CaffeineCacheRegistry registry = new CaffeineCacheRegistry(recordStats);
        // Create every cache now, so its meters exist from startup. Otherwise a cache that has
        // never been touched is simply missing from a scrape, which is indistinguishable from a
        // cache that is broken.
        registry.warmUp();
        return registry;
    }

    /**
     * Binds hit rate, evictions, load latency and size for every cache.
     *
     * <p>Returned as a {@link MeterBinder} rather than bound by hand: Boot binds every MeterBinder
     * bean to every registry it builds. Note {@code CaffeineCacheMetrics.monitor()} returns the
     * <em>cache</em>, not the binder, which is easy to get wrong.
     */
    @Bean
    public MeterBinder switchboardCacheMetrics(CaffeineCacheRegistry registry) {
        return (MeterRegistry meters) -> registry.statsViews().forEach((name, cache) ->
            new CaffeineCacheMetrics<>(cache, name.meterName(), tagsFor(name)).bindTo(meters));
    }

    /** The tier travels onto the meter, so a dashboard can tell local from shared at a glance. */
    private static Tags tagsFor(CacheName name) {
        return Tags.of("tier", name.tier().name().toLowerCase(java.util.Locale.ROOT));
    }
}
