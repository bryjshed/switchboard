package com.switchboard.infrastructure.notify;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.r2dbc.core.DatabaseClient;
import org.springframework.stereotype.Component;
import reactor.core.publisher.Mono;

/**
 * Cross-instance cache eviction, over the same Postgres {@code NOTIFY} mechanism the flag stream
 * already uses.
 *
 * <p>A second channel rather than a second piece of infrastructure: Postgres is already a hard
 * dependency and already carries change propagation, so adding Redis purely to invalidate caches
 * would be buying an outage surface to solve a problem the database can already solve.
 *
 * <p><b>Payload is {@code CACHE_NAME:key}, and the key is text.</b> That is the whole reason
 * {@link CacheRegistry} insists cache keys are Strings: if a key were a UUID on one side of this
 * channel and a stringified UUID on the other, eviction would quietly miss and instances would
 * serve stale entries indefinitely, with no error and no log line to find it by.
 *
 * <p>Failures are logged and swallowed. The write that prompted the eviction has already committed,
 * and the entry will expire on its TTL regardless - a failed NOTIFY costs staleness measured in
 * seconds, not correctness.
 */
@Component
public class CacheInvalidationPublisher {

    public static final String CHANNEL = "cache_invalidate";

    private static final Logger log = LoggerFactory.getLogger(CacheInvalidationPublisher.class);

    private final DatabaseClient db;
    private final CacheRegistry caches;

    public CacheInvalidationPublisher(DatabaseClient db, CacheRegistry caches) {
        this.db = db;
        this.caches = caches;
    }

    /**
     * Evicts locally at once, then tells every other instance.
     *
     * <p>Local first because the instance that made the write is the one most likely to be asked
     * about it next, and it should never be able to read its own stale entry.
     */
    public void evict(CacheName cache, String key) {
        caches.cache(cache).evict(key);
        publish(cache.name() + ":" + key);
    }

    private void publish(String payload) {
        db.sql("SELECT pg_notify('" + CHANNEL + "', :payload)")
            .bind("payload", payload)
            .then()
            .doOnError(e -> log.warn("pg_notify({}) failed for [{}]: {}", CHANNEL, payload, e.getMessage()))
            .onErrorResume(e -> Mono.empty())
            .subscribe();
    }
}
