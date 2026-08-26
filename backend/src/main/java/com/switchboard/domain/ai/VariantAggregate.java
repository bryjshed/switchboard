package com.switchboard.domain.ai;

import com.switchboard.domain.metric.MetricDefinition;
import java.util.Map;
import java.util.UUID;

/**
 * One variation's telemetry over a window. Metric events are attributed to the
 * variation that the same context_key was evaluated into during the window -
 * see {@link RolloutMetricsRepository} for why that simplification is safe here.
 *
 * <p><b>Two units live here and they must not be confused.</b> {@code evalCount} and each
 * metric's {@link MetricCount#events()} count <em>events</em>. A server SDK evaluating a flag in
 * a loop contributes hundreds of them for a single user, so events divided by events is a ratio
 * of event counts and not a proportion of anything. It is a fine number for a volume chart and a
 * wrong number for a statistical test: handing it to a test that assumes independent Bernoulli
 * trials understates the variance by roughly the average evaluations-per-subject.
 *
 * <p>{@code subjectCount} and each metric's {@link MetricCount#subjects()} count distinct context
 * keys. Those are the ones a rate comparison needs, and {@link #proportion(String)} is what the
 * monitor reads.
 *
 * <p><b>Metrics are a map, not columns.</b> They were two fixed pairs of columns - error and
 * conversion - which is what made the healing loop unusable for anything a team actually
 * measures. The map is keyed by {@code metric_events.metric_key}; a metric with no events in the
 * window is simply absent, which reads as {@link MetricCount#EMPTY} rather than as an error.
 *
 * @param rolloutSubjectCount distinct subjects served by the fallthrough rollout
 *     specifically, excluding individual targets and rule matches. Only meaningful for the
 *     sample-ratio-mismatch gate, which compares it against the configured weights.
 */
public record VariantAggregate(
    UUID variationId,
    long evalCount,
    long subjectCount,
    long rolloutSubjectCount,
    Map<String, MetricCount> metrics) {

    public VariantAggregate {
        metrics = metrics == null ? Map.of() : Map.copyOf(metrics);
    }

    /** Absent means no events for that metric in the window, which is zero, not an error. */
    public MetricCount metric(String metricKey) {
        return metrics.getOrDefault(metricKey, MetricCount.EMPTY);
    }

    /**
     * The proportion of exposed subjects that recorded this metric at least once.
     * <b>The decision input.</b>
     */
    public double proportion(String metricKey) {
        return rate(metric(metricKey).subjects(), subjectCount);
    }

    /** Events per evaluation event. Display only - see the class note before testing on it. */
    public double eventRate(String metricKey) {
        return rate(metric(metricKey).events(), evalCount);
    }

    // ------------------------------------------------------------------ API compatibility
    //
    // The four below name the two built-in metrics explicitly, and that is deliberate rather
    // than left-over hard-coding: `VariantStats` in the OpenAPI document has required
    // `errorRate` and `conversionRate` fields that the dashboard reads. Generalising the domain
    // did not have to break a client contract, so it did not. Everything that makes a DECISION
    // goes through the map above.

    /** @deprecated for display and the existing API contract only; prefer {@link #eventRate}. */
    @Deprecated
    public double errorRate() {
        return eventRate(MetricDefinition.ERROR_KEY);
    }

    /** @deprecated for display and the existing API contract only; prefer {@link #eventRate}. */
    @Deprecated
    public double conversionRate() {
        return eventRate(MetricDefinition.CONVERSION_KEY);
    }

    public long errorCount() {
        return metric(MetricDefinition.ERROR_KEY).events();
    }

    public long conversionCount() {
        return metric(MetricDefinition.CONVERSION_KEY).events();
    }

    private static double rate(long numerator, long denominator) {
        if (denominator <= 0) {
            return 0d;
        }
        return Math.min(1d, (double) numerator / (double) denominator);
    }
}
