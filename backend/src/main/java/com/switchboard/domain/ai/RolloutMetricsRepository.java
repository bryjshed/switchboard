package com.switchboard.domain.ai;

import java.time.Instant;
import java.util.UUID;
import reactor.core.publisher.Flux;
import reactor.core.publisher.Mono;

/**
 * Telemetry reads behind the rollout monitor and the rollout-stats endpoint.
 *
 * <p><b>Attribution simplification.</b> metric_events carry no variation id -
 * only a context key - so a metric event is attributed to the variation that the
 * same context_key was evaluated into anywhere in the window. When a context saw
 * more than one variation in the window (a rollout was edited mid-flight), it is
 * attributed to whichever variation it saw most. That is one join and one GROUP
 * BY instead of a per-event lookup, and it is accurate whenever a rollout is
 * stable across the window, which is the case the monitor exists to judge.
 *
 * <p>The consequence for the hourly series: a conversion counts in the hour it
 * was recorded, against the variation the context was served at some point in
 * the window - not necessarily in that same hour.
 */
public interface RolloutMetricsRepository {

    Mono<java.util.List<VariantAggregate>> aggregate(UUID environmentId, String flagKey, Instant since);

    Flux<VariantBucket> hourlyBuckets(UUID environmentId, String flagKey, Instant since);

    /** Every non-archived flag-env head, for the monitor to filter down to real rollouts. */
    Flux<RolloutCandidate> findRolloutCandidates();

    /** Every non-archived flag with its per-environment head state, for the stale sweep. */
    Flux<StaleFlagCandidate> findStaleFlagCandidates();
}
