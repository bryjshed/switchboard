package com.switchboard.application.ai;

import com.switchboard.application.cache.CacheName;
import com.switchboard.application.cache.CacheRegistry;
import com.switchboard.application.cache.SwitchboardCache;
import com.switchboard.application.org.OrgAccessService;
import com.switchboard.domain.ai.RolloutMetricsRepository;
import com.switchboard.domain.ai.VariantAggregate;
import com.switchboard.domain.ai.VariantBucket;
import com.switchboard.domain.common.NotFoundException;
import com.switchboard.domain.flag.Flag;
import com.switchboard.domain.flag.FlagRepository;
import com.switchboard.domain.flag.Variation;
import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;
import org.springframework.stereotype.Service;
import reactor.core.publisher.Mono;

/** Read model behind GET rollout-stats: the same aggregation the monitor screens on. */
@Service
public class RolloutStatsService {

    private static final int MAX_HOURS = 24 * 30;

    private final RolloutMetricsRepository metrics;
    private final OrgAccessService access;
    private final FlagRepository flags;
    private final SwitchboardCache<String, RolloutStats> cache;

    public RolloutStatsService(
        RolloutMetricsRepository metrics, OrgAccessService access, FlagRepository flags,
        CacheRegistry caches) {
        this.metrics = metrics;
        this.access = access;
        this.flags = flags;
        this.cache = caches.cache(CacheName.ROLLOUT_STATS);
    }

    /**
     * The most expensive query in the system, behind a one-minute cache.
     *
     * <p>It is a GROUP BY across the partitioned event tables and it used to run on every Monitor
     * page load. A minute of staleness is invisible to a human reading a chart of continuously
     * arriving telemetry, and the window is bucketed to the hour anyway.
     *
     * <p><b>The authorization check stays outside the cache.</b> Only the aggregation is cached, and
     * the key does not include the caller - so caching cannot be a way to inherit somebody else's
     * access. Whoever asks still has to pass {@code requireEnvironmentMember} on every request.
     */
    public Mono<RolloutStats> get(UUID environmentId, String flagKey, UUID userId, int hours) {
        int capped = Math.max(1, Math.min(hours, MAX_HOURS));
        Instant since = Instant.now().minus(Duration.ofHours(capped)).truncatedTo(ChronoUnit.HOURS);
        String key = environmentId + ":" + flagKey + ":" + capped;
        return access.requireEnvironmentMember(environmentId, userId)
            .flatMap(envAccess -> flags.findByProjectAndKey(envAccess.projectId(), flagKey)
                .switchIfEmpty(Mono.error(new NotFoundException("Flag not found"))))
            .flatMap(flag -> cache.get(key, ignored -> Mono.zip(
                    metrics.aggregate(environmentId, flagKey, since),
                    metrics.hourlyBuckets(environmentId, flagKey, since).collectList())
                .map(t -> new RolloutStats(flagKey, environmentId, names(flag), t.getT1(), t.getT2()))));
    }

    private static Map<UUID, String> names(Flag flag) {
        return flag.variations().stream()
            .collect(Collectors.toMap(Variation::id, RolloutStatsService::displayName, (a, b) -> a));
    }

    private static String displayName(Variation variation) {
        return variation.name() == null || variation.name().isBlank() ? variation.value() : variation.name();
    }

    /** Totals plus hourly buckets, with variation display names resolved once. */
    public record RolloutStats(
        String flagKey,
        UUID environmentId,
        Map<UUID, String> variationNames,
        List<VariantAggregate> totals,
        List<VariantBucket> buckets) {

        public Function<UUID, String> nameLookup() {
            return variationNames::get;
        }
    }
}
