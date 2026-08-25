package com.switchboard.application.cache;

import java.util.function.Function;
import reactor.core.publisher.Mono;

/**
 * One cache, typed, with a reactive read-through.
 *
 * <h2>Why not {@code @Cacheable}</h2>
 *
 * <p>Spring's cache abstraction is synchronous, and applying it to a reactive return type is the
 * documented trap this design exists to avoid: <b>{@code @Cacheable} on a method returning
 * {@code Mono} caches the cold publisher, not the value.</b> Every later caller then gets a
 * publisher that re-executes on subscribe, so the cache appears to work while doing nothing - or
 * worse, the cached {@code Mono} is consumed once and later subscribers see empty. It fails
 * <em>open</em>, silently, which is the worst way for a cache to be wrong.
 *
 * <p>The related trap, also avoided by construction here: {@code @Cacheable} is proxy-based, so a
 * same-class call goes straight past the advice and quietly does nothing. There are no proxies in
 * this design, so there is no self-invocation hazard.
 *
 * <p>This interface is therefore the provider seam rather than {@code CacheManager}: it can be
 * implemented over Caffeine now and over a reactive Redis client later without a service ever
 * learning which one it has, and without a blocking call on an event loop.
 *
 * @param <K> the key type. Whatever it is, it must survive the {@code NOTIFY} invalidation channel,
 *     whose payload is text - see {@link CacheRegistry}.
 */
public interface SwitchboardCache<K, V> {

    /**
     * Reads through the cache, loading on a miss.
     *
     * <p><b>Single-flight per key.</b> Concurrent misses for one key share a single load, so an
     * eviction on a busy environment does not stampede the database.
     *
     * <p>An empty loader result is a first-class outcome, not an error: when the cache
     * {@link CacheName#cachesNegatives() caches negatives} the absence itself is remembered for a
     * short while, which is what closes the "spray unknown keys at the database" vector. When it
     * does not, an empty result is simply not cached and the next call loads again.
     */
    Mono<V> get(K key, Function<K, Mono<V>> loader);

    /** Drops one entry. Safe to call for a key that was never cached. */
    void evict(K key);

    /** Drops everything. Used when a change is too coarse to map onto individual keys. */
    void clear();

    /** Entries currently held. Exposed for metrics and tests, not for logic. */
    long estimatedSize();
}
