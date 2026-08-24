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

    private final AsyncCache<UUID, EnvSnapshot> cache = Caffeine.newBuilder()
        .maximumSize(10_000)
        .expireAfterWrite(Duration.ofMinutes(5))
        .buildAsync();

    private final EnvironmentSnapshotService loader;

    public EnvSnapshotCache(EnvironmentSnapshotService loader) {
        this.loader = loader;
    }

    public Mono<EnvSnapshot> get(UUID environmentId) {
        return Mono.defer(() -> Mono.fromFuture(
            cache.get(environmentId, (key, executor) -> loader.load(key).toFuture())));
    }

    public void invalidate(UUID environmentId) {
        cache.synchronous().invalidate(environmentId);
    }
}
