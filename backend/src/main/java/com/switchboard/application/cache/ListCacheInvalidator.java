package com.switchboard.application.cache;

import com.switchboard.infrastructure.notify.CacheInvalidationPublisher;
import org.springframework.stereotype.Component;

/**
 * Clears the dashboard list caches when something they show has changed.
 *
 * <h2>Why a class rather than a call to evictAll at each site</h2>
 *
 * <p>Because the rule that keeps these caches correct is subtle enough to be worth writing
 * down once instead of trusting eight call sites to remember it:
 *
 * <p><b>Eviction must happen AFTER the transaction commits, never inside it.</b> Evicting
 * inside the transaction opens a race with a window wide enough to hit in practice: the
 * evict runs, a concurrent reader misses and re-loads, the reader sees pre-commit data and
 * caches it, and then the commit lands with no further eviction. The result is a cache that
 * is stale indefinitely, with no error and nothing in the log - the exact failure mode the
 * seam's other invariants exist to prevent. Every caller here is on a post-commit hook.
 *
 * <p><b>The list caches are cleared wholesale, not evicted by key.</b> A page is keyed by its
 * filters and cursor, so one flag changing invalidates an unknowable set of keys - every page
 * whose filter that flag matched, which cannot be computed without running the queries. The
 * blunt version is correct; enumerating would be guesswork. It is affordable because the
 * writes that trigger it are human-paced and the reads that pay for it are one query.
 *
 * <p>This is what makes the TTL on these caches a backstop rather than a staleness budget:
 * the answer to "how stale can a flag list be" is meant to be "it cannot be", and the TTL is
 * only there in case a {@code NOTIFY} is dropped.
 */
@Component
public class ListCacheInvalidator {

    private final CacheInvalidationPublisher publisher;

    public ListCacheInvalidator(CacheInvalidationPublisher publisher) {
        this.publisher = publisher;
    }

    /**
     * Anything that changes what a flag list shows: create, archive, a rename or retag, a
     * targeting write, a kill switch, a rollback, a segment edit.
     *
     * <p>Note this is deliberately broader than "a targeting write". A rename changes the
     * list and bumps no state version, so a design that hung invalidation off the existing
     * {@code flag_change} NOTIFY alone would serve a stale name until the TTL expired.
     */
    public void flagsChanged() {
        publisher.evictAll(CacheName.FLAG_LIST);
    }

    /**
     * Any change-request lifecycle transition.
     *
     * <p>Also clears the flag list, because APPLYING a change request writes a flag config -
     * and forgetting that half is how a queue and a flag list end up disagreeing about what
     * is live.
     */
    public void changeRequestsChanged() {
        publisher.evictAll(CacheName.CHANGE_REQUEST_LIST);
        publisher.evictAll(CacheName.FLAG_LIST);
    }
}
