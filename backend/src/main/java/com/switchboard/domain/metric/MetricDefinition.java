package com.switchboard.domain.metric;

import java.time.Instant;
import java.util.UUID;

/**
 * A metric the rollout monitor may act on.
 *
 * @param key      matches {@code metric_events.metric_key}. Not a foreign key anywhere: events
 *                 arrive from SDKs before anyone defines a metric, and refusing telemetry for an
 *                 undefined key would lose data that becomes meaningful the moment it is defined.
 * @param tau      the absolute proportion difference worth reacting to. Per metric, because a 1%
 *                 shift means something different for an error rate than for a refund rate.
 *                 <b>Never fit this to observed data</b> - DECISIONS.md explains that doing so
 *                 makes the constant a function of the sample and destroys the supermartingale
 *                 property that makes repeated looks safe.
 * @param autoAct  whether the monitor may heal or ramp on this metric, or only report it. A team
 *                 measuring something noisy wants to see it without it moving traffic.
 */
public record MetricDefinition(
    UUID id,
    UUID projectId,
    String key,
    String name,
    String description,
    MetricDirection direction,
    double tau,
    boolean autoAct,
    Instant createdAt,
    Instant updatedAt) {

    /** The two the monitor used to hard-code, seeded into every project by V10. */
    public static final String ERROR_KEY = "error";
    public static final String CONVERSION_KEY = "conversion";
}
