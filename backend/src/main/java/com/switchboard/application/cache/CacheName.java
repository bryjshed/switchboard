package com.switchboard.application.cache;

import java.time.Duration;

/**
 * Every cache in the system, and what each one is for.
 *
 * <p>An enum rather than a validated set of strings. The plan called for freezing the name set so a
 * typo fails loudly at startup; an enum does better than that by failing at compile time, and it
 * gives each cache one place to say what it holds and why its TTL is what it is.
 *
 * <p>{@link Tier} is declared per cache now even though Caffeine makes every cache local today.
 * Deciding it up front is much cheaper than retrofitting: anything holding per-instance state or
 * decrypted material must never move to a shared store, and that judgement is easiest to make while
 * the cache is being written rather than during a Redis migration.
 */
public enum CacheName {

    /**
     * Environment id -> the whole evaluable snapshot. The hot path: evaluation, bootstrap and the
     * SSE payload all read through it.
     *
     * <p>LOCAL because {@code NOTIFY} already invalidates every instance, so a shared copy would
     * add a network hop to the hottest read in the product and buy nothing.
     */
    ENV_SNAPSHOT(Tier.LOCAL, Duration.ofMinutes(5), 10_000, Duration.ZERO),

    /**
     * SDK key hash -> the principal it resolves to. The largest single win available: this ran a
     * three-table join on <em>every</em> evaluation request, and the mapping only changes when a
     * key is minted or revoked.
     *
     * <p>Negative entries are cached deliberately and briefly. An unknown key used to hit the
     * database every time, so a scanner spraying bad keys was an unbounded-load denial-of-service
     * vector rather than merely wasteful. The short negative TTL bounds how long a genuinely new
     * key stays rejected after being minted on another instance.
     */
    SDK_KEY(Tier.LOCAL, Duration.ofMinutes(10), 50_000, Duration.ofSeconds(30)),

    /**
     * (issuer, subject) -> user id. Resolved on every authenticated management request.
     *
     * <p>No negative caching: an absent identity is provisioned on first sight, so caching the
     * absence would fight the auto-provisioning path.
     */
    USER_IDENTITY(Tier.LOCAL, Duration.ofMinutes(5), 10_000, Duration.ZERO),

    /**
     * (user, scope) -> resolved permissions. A union query ran per authorization decision, and a
     * single dashboard page load makes several.
     *
     * <p>Short TTL on purpose: this is the cache where staleness means someone keeps access they
     * were just denied, so it trades a smaller hit rate for a smaller window.
     */
    PERMISSIONS(Tier.LOCAL, Duration.ofSeconds(30), 20_000, Duration.ZERO),

    /**
     * (environment, flag, window) -> aggregated rollout statistics. The most expensive query in the
     * system - a GROUP BY across the partitioned event tables - recomputed on every Monitor page
     * load.
     *
     * <p>A minute is plenty: the underlying data is telemetry that arrives continuously, so no
     * human reading a chart can tell the difference.
     */
    ROLLOUT_STATS(Tier.LOCAL, Duration.ofMinutes(1), 2_000, Duration.ZERO);

    /** Whether a cache may live in a shared store when one is configured. */
    public enum Tier {
        /**
         * Per-instance, invalidated by notification. Correct for anything that is cheap to rebuild
         * or that must never leave the process.
         */
        LOCAL,
        /**
         * Eligible for a shared store under a provider that has one. Nothing is REPLICATED today;
         * the tier exists so that decision is recorded per cache rather than assumed.
         */
        REPLICATED
    }

    private final Tier tier;
    private final Duration ttl;
    private final long maximumSize;
    private final Duration negativeTtl;

    CacheName(Tier tier, Duration ttl, long maximumSize, Duration negativeTtl) {
        this.tier = tier;
        this.ttl = ttl;
        this.maximumSize = maximumSize;
        this.negativeTtl = negativeTtl;
    }

    public Tier tier() {
        return tier;
    }

    public Duration ttl() {
        return ttl;
    }

    public long maximumSize() {
        return maximumSize;
    }

    /** Zero means "do not cache absence at all", which is the default for most caches. */
    public Duration negativeTtl() {
        return negativeTtl;
    }

    public boolean cachesNegatives() {
        return !negativeTtl.isZero() && !negativeTtl.isNegative();
    }

    /** The name Micrometer reports this cache under. */
    public String meterName() {
        return name().toLowerCase(java.util.Locale.ROOT);
    }
}
