package com.switchboard.application.evaluation;

import com.github.benmanes.caffeine.cache.AsyncCache;
import com.github.benmanes.caffeine.cache.Caffeine;
import java.time.Duration;
import java.util.UUID;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * Explicit Caffeine AsyncCache over environment snapshots. Deliberately NOT
 * Spring @Cacheable: @Cacheable on a Mono caches the publisher, not the value.
 * Entries are evicted on NOTIFY (flag_change) and after local writes; the TTL is
 * only a backstop against missed notifications.
 */
@Component
public class EnvSnapshotCache {

    /** Cache name used for the Micrometer meters bound in MetricsConfig. */
    public static final String CACHE_NAME = "envSnapshot";

    private final AsyncCache<UUID, EnvSnapshot> cache = Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(Duration.ofMinutes(5))
        // Off by default in Caffeine, and every hit-rate number depends on it. Without this the
        // cache works and reports nothing, which is indistinguishable from a cache that is not
        // working.
        .recordStats()
        .buildAsync();

    private final EnvironmentSnapshotService loader;

    public EnvSnapshotCache(EnvironmentSnapshotService loader) {
        this.loader = loader;
    }

    /**
     * The synchronous view, for binding metrics. Shares one stats counter with the async cache,
     * so the numbers cover every access including those served through {@link #get}.
     */
    public com.github.benmanes.caffeine.cache.Cache<UUID, EnvSnapshot> statsView() {
        return cache.synchronous();
    }

    public Mono<EnvSnapshot> get(UUID environmentId) {
        return Mono.defer(() -> Mono.fromFuture(
            cache.get(environmentId, (key, executor) -> loader.load(key).toFuture())));
    }

    public void invalidate(UUID environmentId) {
        cache.synchronous().invalidate(environmentId);
    }
}
