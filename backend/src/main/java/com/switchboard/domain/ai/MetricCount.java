package com.switchboard.domain.ai;

/**
 * One metric's telemetry for one variation, in both units.
 *
 * <p><b>The two are not interchangeable and confusing them is the defect this codebase already
 * fixed once.</b> {@code events} counts metric events; a subject can contribute many. {@code
 * subjects} counts distinct context keys. A rate comparison needs {@code subjects} - handing a
 * ratio of event counts to a test that assumes independent Bernoulli trials understates the
 * variance by roughly the average events-per-subject. {@code events} is the right number for a
 * volume chart and the wrong one for a decision.
 */
public record MetricCount(long events, long subjects) {

    public static final MetricCount EMPTY = new MetricCount(0, 0);
}
