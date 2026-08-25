package com.switchboard.application.evaluation;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.application.cache.SwitchboardCache;
import java.util.UUID;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * Environment snapshots, on the shared cache seam.
 *
 * <p>This was a hand-rolled Caffeine {@code AsyncCache} wired straight into the service, and it was
 * right about the important thing: Spring's {@code @Cacheable} on a {@code Mono} caches the cold
 * publisher rather than the value, so it appears to work while doing nothing. The seam it now sits
 * on generalises exactly that pattern - an {@code AsyncCache} for single-flight, {@code
 * Mono.fromFuture} to stay off the blocking path - so this class keeps its behaviour and stops
 * being a one-off.
 *
 * <p>It was migrated first, on purpose: it already worked, so the seam got proven against something
 * known-good before anything else depended on it.
 *
 * <p>Entries are evicted on {@code NOTIFY} and after local writes; the TTL is only a backstop
 * against a missed notification.
 */
@Component
public class EnvSnapshotCache {

    /** Retained for the meter name and for tests that assert on it. */
    public static final String CACHE_NAME = CacheName.ENV_SNAPSHOT.meterName();

    private final SwitchboardCache<String, EnvSnapshot> cache;
    private final EnvironmentSnapshotService loader;

    public EnvSnapshotCache(CacheRegistry caches, EnvironmentSnapshotService loader) {
        this.cache = caches.cache(CacheName.ENV_SNAPSHOT);
        this.loader = loader;
    }

    public Mono<EnvSnapshot> get(UUID environmentId) {
        return cache.get(environmentId.toString(), key -> loader.load(environmentId));
    }

    public void invalidate(UUID environmentId) {
        cache.evict(environmentId.toString());
    }
}
