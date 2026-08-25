package com.switchboard.domain.ai;

import java.util.UUID;

/**
 * One variation's telemetry over a window. Metric events are attributed to the
 * variation that the same context_key was evaluated into during the window -
 * see {@link RolloutMetricsRepository} for why that simplification is safe here.
 *
 * <p><b>Two units live here and they must not be confused.</b> {@code evalCount},
 * {@code errorCount} and {@code conversionCount} count <em>events</em>. A server SDK
 * evaluating a flag in a loop contributes hundreds of them for a single user, so
 * {@code errorCount / evalCount} is a ratio of event counts and not a proportion of
 * anything. It is a fine number for a volume chart and a wrong number for a statistical
 * test: handing it to a test that assumes independent Bernoulli trials understates the
 * variance by roughly the average evaluations-per-subject.
 *
 * <p>{@code subjectCount}, {@code errorSubjects} and {@code conversionSubjects} count
 * distinct context keys. Those are the ones a rate comparison needs, and
 * {@link #errorProportion()} / {@link #conversionProportion()} are what the monitor reads.
 *
 * @param rolloutSubjectCount distinct subjects served by the fallthrough rollout
 *     specifically, excluding individual targets and rule matches. Only meaningful for the
 *     sample-ratio-mismatch gate, which compares it against the configured weights.
 */
public record VariantAggregate(
    UUID variationId,
    long evalCount,
    long errorCount,
    long conversionCount,
    long subjectCount,
    long rolloutSubjectCount,
    long errorSubjects,
    long conversionSubjects) {

    /** Errors per evaluation event. Display only - see the class note before using it in a test. */
    public double errorRate() {
        return rate(errorCount, evalCount);
    }

    /** Conversions per evaluation event. Display only. */
    public double conversionRate() {
        return rate(conversionCount, evalCount);
    }

    /** The proportion of exposed subjects that hit at least one error. The decision input. */
    public double errorProportion() {
        return rate(errorSubjects, subjectCount);
    }

    /** The proportion of exposed subjects that converted at least once. The decision input. */
    public double conversionProportion() {
        return rate(conversionSubjects, subjectCount);
    }

    private static double rate(long numerator, long denominator) {
        if (denominator <= 0) {
            return 0d;
        }
        return Math.min(1d, (double) numerator / (double) denominator);
    }
}
