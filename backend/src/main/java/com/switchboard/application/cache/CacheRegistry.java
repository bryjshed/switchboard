package com.switchboard.application.cache;

/**
 * Where a service gets its cache.
 *
 * <p>The provider is a configuration choice ({@code switchboard.cache.provider}); nothing that
 * calls this knows or cares which one is in force. That is the whole point of the seam - the day a
 * shared tier is justified, no service code changes.
 *
 * <h2>Keys must survive the invalidation channel</h2>
 *
 * <p>Invalidation rides Postgres {@code NOTIFY}, whose payload is text. If a key is a
 * {@code UUID} on one side of that channel and a stringified UUID on the other, eviction quietly
 * misses and instances serve stale config indefinitely - a failure with no error and no log line.
 *
 * <p>So the rule is: <b>cache keys are Strings, canonicalised at the call site.</b> It is less
 * pretty than a typed key and it is the representation that cannot drift, because it is the same
 * one the wire uses.
 */
public interface CacheRegistry {

    /**
     * The cache for this name, created on first request and shared thereafter.
     *
     * <p>Nothing validates the name because nothing can fail to: {@link CacheName} is an enum, so a
     * typo is a compile error rather than a startup error or - worse - a silently created unbounded
     * cache.
     */
    <V> SwitchboardCache<String, V> cache(CacheName name);
}
