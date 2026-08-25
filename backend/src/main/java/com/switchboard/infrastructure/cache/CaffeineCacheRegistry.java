package com.switchboard.infrastructure.cache;

import com.github.benmanes.caffeine.cache.AsyncCache;
import com.github.benmanes.caffeine.cache.Caffeine;
import com.github.benmanes.caffeine.cache.Expiry;
import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.application.cache.SwitchboardCache;
import java.util.EnumMap;
import java.util.Map;
import java.util.Optional;
import java.util.function.Function;
import org.jspecify.annotations.NonNull;
import reactor.core.publisher.Mono;

/**
 * The Caffeine-backed registry: correct for a single instance, and correct for several, because
 * {@code NOTIFY} already invalidates every one of them.
 *
 * <p>Built on {@link AsyncCache} rather than the synchronous {@code Cache} for two reasons. It
 * gives single-flight per key for free - concurrent misses share one load - and it composes with
 * {@code Mono.fromFuture} without ever blocking an event-loop thread. This is the pattern
 * {@code EnvSnapshotCache} already proved before the seam existed.
 */
public class CaffeineCacheRegistry implements CacheRegistry {

    private final Map<CacheName, SwitchboardCache<String, ?>> caches = new EnumMap<>(CacheName.class);
    private final boolean recordStats;

    public CaffeineCacheRegistry(boolean recordStats) {
        this.recordStats = recordStats;
    }

    @Override
    @SuppressWarnings("unchecked")
    public synchronized <V> SwitchboardCache<String, V> cache(CacheName name) {
        return (SwitchboardCache<String, V>) caches.computeIfAbsent(name, this::build);
    }

    private <V> SwitchboardCache<String, V> build(CacheName name) {
        Caffeine<Object, Object> base = Caffeine.newBuilder().maximumSize(name.maximumSize());
        if (recordStats) {
            // Off by default in Caffeine, and every hit-rate number depends on it. Without this the
            // cache works while reporting nothing, which reads identically to a cache with no
            // traffic.
            base = base.recordStats();
        }
        AsyncCache<String, Optional<V>> delegate = name.cachesNegatives()
            ? base.<String, Optional<V>>expireAfter(new PresenceAwareExpiry<V>(name)).buildAsync()
            : base.expireAfterWrite(name.ttl()).<String, Optional<V>>buildAsync();
        return new CaffeineBackedCache<>(name, delegate);
    }

    /**
     * A remembered absence expires on its own, shorter clock.
     *
     * <p>Negative entries exist to stop an unknown key from reaching the database on every attempt.
     * They must not live as long as real entries, though: a key minted on another instance would
     * otherwise stay rejected here for the full TTL, which turns a performance fix into an outage
     * for whoever just created the key.
     */
    private static final class PresenceAwareExpiry<V> implements Expiry<String, Optional<V>> {

        private final CacheName name;

        private PresenceAwareExpiry(CacheName name) {
            this.name = name;
        }

        private long durationFor(Optional<V> value) {
            return value != null && value.isPresent()
                ? name.ttl().toNanos()
                : name.negativeTtl().toNanos();
        }

        @Override
        public long expireAfterCreate(
            @NonNull String key, @NonNull Optional<V> value, long currentTime) {
            return durationFor(value);
        }

        @Override
        public long expireAfterUpdate(
            @NonNull String key, @NonNull Optional<V> value, long currentTime, long currentDuration) {
            return durationFor(value);
        }

        @Override
        public long expireAfterRead(
            @NonNull String key, @NonNull Optional<V> value, long currentTime, long currentDuration) {
            // Reading does not extend the life of an entry: TTL here means "how stale may this be",
            // and a popular key must not be able to outrun that by being popular.
            return currentDuration;
        }
    }

    /**
     * Values are wrapped in {@link Optional} rather than stored bare.
     *
     * <p>Caffeine refuses to cache null, so an empty loader result would otherwise be a miss every
     * single time - which is exactly the unknown-key denial-of-service vector. Wrapping makes
     * "known to be absent" a cacheable value in its own right.
     */
    private static final class CaffeineBackedCache<V> implements SwitchboardCache<String, V> {

        private final CacheName name;
        private final AsyncCache<String, Optional<V>> delegate;

        private CaffeineBackedCache(CacheName name, AsyncCache<String, Optional<V>> delegate) {
            this.name = name;
            this.delegate = delegate;
        }

        @Override
        public Mono<V> get(String key, Function<String, Mono<V>> loader) {
            return Mono.defer(() -> Mono.fromFuture(
                    delegate.get(key, (k, executor) -> loader.apply(k)
                        .map(Optional::of)
                        .defaultIfEmpty(Optional.empty())
                        .toFuture())))
                .flatMap(value -> value.map(Mono::just).orElseGet(Mono::empty))
                // Not caching absence means the entry must go, or the empty Optional sticks for the
                // full positive TTL and the next caller is told "absent" without ever asking.
                .switchIfEmpty(Mono.fromRunnable(() -> {
                    if (!name.cachesNegatives()) {
                        delegate.synchronous().invalidate(key);
                    }
                }));
        }

        @Override
        public void evict(String key) {
            delegate.synchronous().invalidate(key);
        }

        @Override
        public void clear() {
            delegate.synchronous().invalidateAll();
        }

        @Override
        public long estimatedSize() {
            return delegate.synchronous().estimatedSize();
        }

        /** For metric binding only. */
        com.github.benmanes.caffeine.cache.Cache<String, Optional<V>> statsView() {
            return delegate.synchronous();
        }
    }

    /** The synchronous views, for binding Micrometer meters. */
    @SuppressWarnings("unchecked")
    public synchronized Map<CacheName, com.github.benmanes.caffeine.cache.Cache<String, ?>> statsViews() {
        Map<CacheName, com.github.benmanes.caffeine.cache.Cache<String, ?>> views =
            new EnumMap<>(CacheName.class);
        caches.forEach((name, cache) ->
            views.put(name, ((CaffeineBackedCache<Object>) cache).statsView()));
        return views;
    }

    /** Eagerly creates every cache, so metrics exist before the first request rather than after. */
    public synchronized void warmUp() {
        for (CacheName name : CacheName.values()) {
            cache(name);
        }
    }
}
