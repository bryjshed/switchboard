package com.switchboard.infrastructure.cache;

import static org.assertj.core.api.Assertions.assertThat;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.SwitchboardCache;
import java.time.Duration;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import reactor.core.publisher.Mono;
import reactor.test.StepVerifier;

/**
 * The cache seam, and specifically the trap it exists to avoid.
 *
 * <p>{@link #theLoaderRunsOnceAcrossTwoSubscriptions()} is the one that matters. Spring's
 * {@code @Cacheable} on a {@code Mono} caches the cold publisher rather than the value, so every
 * later caller gets something that re-executes on subscribe: the cache appears to work while doing
 * nothing. It fails open and silently, which is why it needs a test that would catch it rather than
 * a comment saying it was considered.
 */
class CaffeineCacheRegistryTest {

    private final CaffeineCacheRegistry registry = new CaffeineCacheRegistry(true);

    @Test
    @DisplayName("the loader runs ONCE across two subscriptions, not once per subscribe")
    void theLoaderRunsOnceAcrossTwoSubscriptions() {
        SwitchboardCache<String, String> cache = registry.cache(CacheName.ENV_SNAPSHOT);
        AtomicInteger loads = new AtomicInteger();
        Mono<String> read = cache.get("k", key -> Mono.fromCallable(() -> {
            loads.incrementAndGet();
            return "loaded";
        }));

        // Two independent subscriptions to the SAME Mono. Under the @Cacheable-on-Mono failure mode
        // this loads twice, because what got cached was a publisher rather than a value.
        StepVerifier.create(read).expectNext("loaded").verifyComplete();
        StepVerifier.create(read).expectNext("loaded").verifyComplete();

        assertThat(loads.get()).as("cached value, not cached publisher").isEqualTo(1);
    }

    @Test
    @DisplayName("concurrent misses for one key share a single load")
    void concurrentMissesShareOneLoad() {
        SwitchboardCache<String, String> cache = registry.cache(CacheName.ENV_SNAPSHOT);
        AtomicInteger loads = new AtomicInteger();

        // A slow loader, so the second subscriber is guaranteed to arrive mid-flight. Without
        // single-flight this is the stampede an eviction on a busy environment causes.
        Mono<String> slow = cache.get("hot", key -> Mono.delay(Duration.ofMillis(100))
            .map(tick -> {
                loads.incrementAndGet();
                return "loaded";
            }));

        StepVerifier.create(Mono.zip(slow, slow, slow))
            .assertNext(values -> assertThat(values.getT1()).isEqualTo("loaded"))
            .verifyComplete();

        assertThat(loads.get()).isEqualTo(1);
    }

    @Test
    @DisplayName("eviction actually evicts")
    void evictionForcesAReload() {
        SwitchboardCache<String, String> cache = registry.cache(CacheName.ENV_SNAPSHOT);
        AtomicInteger loads = new AtomicInteger();

        Mono<String> read = cache.get("k",
            key -> Mono.fromCallable(() -> "v" + loads.incrementAndGet()));

        StepVerifier.create(read).expectNext("v1").verifyComplete();
        cache.evict("k");
        StepVerifier.create(read).expectNext("v2").verifyComplete();
        assertThat(loads.get()).isEqualTo(2);
    }

    @Test
    @DisplayName("a cache that does not cache negatives reloads an absent key every time")
    void absenceIsNotCachedByDefault() {
        // ENV_SNAPSHOT has no negative TTL: an environment that does not exist yet must not be
        // remembered as non-existent, or creating one would appear not to work.
        assertThat(CacheName.ENV_SNAPSHOT.cachesNegatives()).isFalse();

        SwitchboardCache<String, String> cache = registry.cache(CacheName.ENV_SNAPSHOT);
        AtomicInteger loads = new AtomicInteger();
        Mono<String> read = cache.get("missing", key -> Mono.fromRunnable(loads::incrementAndGet));

        StepVerifier.create(read).verifyComplete();
        StepVerifier.create(read).verifyComplete();

        assertThat(loads.get())
            .as("an empty result must not stick as a cached absence here")
            .isEqualTo(2);
    }

    @Test
    @DisplayName("a cache that DOES cache negatives remembers an absent key")
    void absenceIsCachedWhereConfigured() {
        // SDK_KEY does cache negatives: an unknown key hitting the database on every attempt is a
        // denial-of-service vector, not merely waste.
        assertThat(CacheName.SDK_KEY.cachesNegatives()).isTrue();

        SwitchboardCache<String, String> cache = registry.cache(CacheName.SDK_KEY);
        AtomicInteger loads = new AtomicInteger();
        Mono<String> read = cache.get("bogus", key -> Mono.fromRunnable(loads::incrementAndGet));

        StepVerifier.create(read).verifyComplete();
        StepVerifier.create(read).verifyComplete();
        StepVerifier.create(read).verifyComplete();

        assertThat(loads.get())
            .as("a sprayed unknown key must reach the database once, not once per attempt")
            .isEqualTo(1);
    }

    @Test
    @DisplayName("a negative entry does not outlive its own shorter TTL")
    void negativeTtlIsShorterThanThePositiveOne() {
        // Otherwise a key minted on another instance stays rejected here for the full positive TTL,
        // which turns a performance fix into an outage for whoever just created it.
        assertThat(CacheName.SDK_KEY.negativeTtl())
            .isLessThan(CacheName.SDK_KEY.ttl())
            .isPositive();
    }

    @Test
    @DisplayName("each name gets one shared instance")
    void cachesAreSharedPerName() {
        assertThat(registry.cache(CacheName.SDK_KEY))
            .isSameAs(registry.cache(CacheName.SDK_KEY))
            .isNotSameAs(registry.cache(CacheName.PERMISSIONS));
    }

    @Test
    @DisplayName("warmUp creates every cache so its meters exist from startup")
    void warmUpCreatesEveryCache() {
        CaffeineCacheRegistry fresh = new CaffeineCacheRegistry(true);
        fresh.warmUp();
        assertThat(fresh.statsViews()).hasSize(CacheName.values().length);
    }
}
